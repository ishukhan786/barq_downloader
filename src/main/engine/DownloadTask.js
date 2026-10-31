'use strict';

const EventEmitter = require('node:events');
const path = require('node:path');
const { HttpClient } = require('./HttpClient');
const { DownloadWriter } = require('./DownloadWriter');
const { SpeedTracker } = require('./SpeedTracker');
const { ResumeManager } = require('./ResumeManager');
const { RetryManager } = require('./RetryManager');
const { DownloadValidator } = require('./DownloadValidator');

const PROGRESS_THROTTLE_MS = 250;

/**
 * Strict state machine and lifecycle coordinator for an individual download task.
 */
class DownloadTask extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.id download id
   * @param {object} opts.record database record
   * @param {import('../db/downloads-repo').DownloadsRepo} opts.repo
   * @param {import('../logger').createLogger} opts.logger
   */
  constructor({ id, record, repo, logger }) {
    super();
    this.id = id;
    this.record = { ...record };
    this.repo = repo;
    this.logger = logger;

    this.state = this.record.status === 'downloading' ? 'paused' : (this.record.status === 'queued' ? 'pending' : (this.record.status || 'pending'));
    this.writer = null;
    this.speedTracker = new SpeedTracker();
    this.abortFn = null;
    this.retryTimer = null;
    this.lastProgressEmit = 0;

    this.downloadedBytes = this.record.downloaded_bytes || 0;
    this.totalBytes = this.record.total_bytes ?? null;
  }

  get isRunning() {
    return ['preparing', 'downloading', 'resuming', 'retrying'].includes(this.state);
  }

  /**
   * Transitions to a new state if permitted.
   */
  _setState(newState, extra = {}) {
    const prev = this.state;
    this.state = newState;
    this.logger.info(`Task #${this.id} state: ${prev} -> ${newState}`, { extra });

    // Persist to database on milestone transitions
    const dbStatusMap = {
      pending: 'queued',
      preparing: 'queued',
      resuming: 'downloading',
      downloading: 'downloading',
      pausing: 'downloading',
      paused: 'paused',
      retrying: 'downloading',
      completed: 'completed',
      failed: 'failed',
      cancelling: 'canceled',
      cancelled: 'canceled',
    };

    const targetDbStatus = dbStatusMap[newState];
    if (targetDbStatus) {
      this.record.status = targetDbStatus;
      if (extra.errorCode !== undefined) this.record.error_code = extra.errorCode;
      if (extra.errorMessage !== undefined) this.record.error_message = extra.errorMessage;
      if (newState === 'completed') {
        this.record.error_code = null;
        this.record.error_message = null;
      }
      try {
        this.repo.updateStatus(this.id, targetDbStatus, {
          error_code: this.record.error_code,
          error_message: this.record.error_message,
          completed_at: newState === 'completed' ? Date.now() : null,
          partial_path: this.writer ? this.writer.partialPath : undefined,
        });
      } catch (err) {
        this.logger.error(`Task #${this.id} DB status update failed:`, err);
      }
    }

    this.emit('state-changed', {
      id: this.id,
      state: this.state,
      dbStatus: targetDbStatus,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      extra,
    });
  }

  /**
   * Starts or resumes the download task.
   */
  async start() {
    if (this.state === 'preparing' || this.state === 'downloading' || this.state === 'resuming') {
      return;
    }

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this._setState(this.downloadedBytes > 0 ? 'resuming' : 'preparing');

    // Setup writer
    this.writer = new DownloadWriter({
      destinationPath: this.record.destination_path,
      filename: this.record.filename,
      partialPath: this.record.partial_path,
    });

    this._executionPromise = (async () => {
      try {
        await this._executeDownload();
      } catch (err) {
        await this._handleExecutionError(err);
      }
    })();

    return Promise.resolve();
  }

  /**
   * Internal streaming pipeline execution.
   */
  async _executeDownload() {
    // 1. Assess resume possibility if we have existing partial data
    let rangeStart = null;
    let ifRange = null;
    const partialBytes = this.writer.getExistingBytes();

    if (partialBytes > 0) {
      const resumeCheck = ResumeManager.assessResume(this.record, this.writer.partialPath);
      if (resumeCheck.canAttemptResume) {
        rangeStart = resumeCheck.actualBytes;
        ifRange = this.record.etag || this.record.last_modified;
        this.logger.info(`Task #${this.id} attempting resume at offset ${rangeStart}`);
      } else {
        this.logger.info(`Task #${this.id} resume not viable (${resumeCheck.reason}), starting from 0`);
      }
    }

    // 2. Request stream from server
    const streamRes = await HttpClient.getStream(this.record.source_url, {
      rangeStart,
      ifRange,
    });

    this.abortFn = streamRes.abort;

    if (this.state === 'pausing' || this.state === 'cancelling') {
      streamRes.abort();
      return;
    }

    const { statusCode, headers, response } = streamRes;

    // 3. Evaluate server response
    let openInAppendMode = false;

    if (rangeStart !== null) {
      const resumeEval = ResumeManager.evaluateResumeResponse({
        statusCode,
        headers,
        requestedOffset: rangeStart,
        previousRecord: this.record,
      });

      if (resumeEval.action === 'append') {
        openInAppendMode = true;
        this.downloadedBytes = resumeEval.startOffset;
        if (resumeEval.totalBytes !== null) {
          this.totalBytes = resumeEval.totalBytes;
        }
      } else if (resumeEval.action === 'restart') {
        this.logger.info(`Task #${this.id} restart triggered: ${resumeEval.reason}`);
        openInAppendMode = false;
        this.downloadedBytes = 0;
        if (headers['content-length']) {
          const cl = Number.parseInt(headers['content-length'], 10);
          if (!Number.isNaN(cl)) {
            this.totalBytes = cl;
          }
        }
      } else if (resumeEval.action === 'complete') {
        response.resume();
        await this._handleCompletion();
        return;
      } else {
        response.resume();
        throw new Error(resumeEval.error || `Server rejected resume (HTTP ${statusCode})`);
      }
    } else {
      // Direct full download: Validate HTTP status
      const statusCheck = DownloadValidator.validateStatus(statusCode);
      if (!statusCheck.ok) {
        response.resume();
        const err = new Error(statusCheck.errorMessage);
        err.code = statusCheck.errorCode;
        err.statusCode = statusCode;
        err.headers = headers;
        err.recoverable = statusCheck.recoverable;
        throw err;
      }

      openInAppendMode = false;
      this.downloadedBytes = 0;

      // Extract Content-Length & Range capability
      if (headers['content-length']) {
        const cl = Number.parseInt(headers['content-length'], 10);
        if (!Number.isNaN(cl)) this.totalBytes = cl;
      }

      const acceptRanges = headers['accept-ranges'] || '';
      if (acceptRanges.toLowerCase().includes('bytes') || statusCode === 206) {
        this.record.supports_ranges = 1;
      }
    }

    // Update discovered metadata in SQLite
    this.record.etag = headers['etag'] || this.record.etag;
    this.record.last_modified = headers['last-modified'] || this.record.last_modified;
    this.record.mime_type = headers['content-type'] ? headers['content-type'].split(';')[0].trim() : this.record.mime_type;

    try {
      this.repo.updateMetadata(this.id, {
        etag: this.record.etag,
        last_modified: this.record.last_modified,
        mime_type: this.record.mime_type,
        total_bytes: this.totalBytes,
        supports_ranges: this.record.supports_ranges,
        partial_path: this.writer.partialPath,
      });
    } catch {}

    // 4. Open writer and pipe
    this.writer.open(openInAppendMode);
    this.speedTracker.start(this.downloadedBytes);
    this._setState('downloading');

    await new Promise((resolve, reject) => {
      this.writer.pipe(response, {
        onProgress: (chunkLen, totalWritten) => {
          this.downloadedBytes = totalWritten;
          this.speedTracker.record(this.downloadedBytes);
          this._emitProgress();
        },
        onError: (err) => {
          reject(err);
        },
        onEnd: () => {
          resolve();
        },
      });
    });

    if (this.state === 'downloading') {
      await this._handleCompletion();
    }
  }

  /**
   * Emits throttled progress event to listeners/IPC.
   */
  _emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressEmit < PROGRESS_THROTTLE_MS) {
      return;
    }
    this.lastProgressEmit = now;

    const currentSpeed = this.speedTracker.getCurrentSpeed(now);
    const avgSpeed = this.speedTracker.getAverageSpeed(now);
    const eta = this.speedTracker.getEta(this.totalBytes, this.downloadedBytes, currentSpeed);

    // Save progress periodically to database
    try {
      this.repo.updateProgress(this.id, {
        downloaded_bytes: this.downloadedBytes,
        total_bytes: this.totalBytes,
        status: 'downloading',
      });
    } catch {}

    this.emit('progress', {
      id: this.id,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      currentSpeed,
      avgSpeed,
      etaSeconds: eta,
      state: this.state,
    });
  }

  /**
   * Handles download finalization and verification.
   */
  async _handleCompletion() {
    this.abortFn = null;

    // Verify completion
    const validation = DownloadValidator.validateCompletion(this.downloadedBytes, this.totalBytes);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    if (this.writer) {
      await this.writer.finalize();
    }

    this._emitProgress(true);
    this._setState('completed');
  }

  /**
   * Pauses the active download, flushes partial data to disk, and transitions safely to paused.
   */
  async pause() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.state === 'paused' || this.state === 'pausing') return;

    this._setState('pausing');

    if (this.abortFn) {
      this.abortFn();
      this.abortFn = null;
    }

    if (this._executionPromise) {
      await this._executionPromise.catch(() => {});
      this._executionPromise = null;
    }

    if (this.writer) {
      try {
        const persisted = await this.writer.close();
        this.downloadedBytes = persisted;
      } catch (err) {
        this.logger.error(`Task #${this.id} error closing writer during pause:`, err);
      }
    }

    this.speedTracker.reset();

    try {
      this.repo.updateProgress(this.id, {
        downloaded_bytes: this.downloadedBytes,
        total_bytes: this.totalBytes,
        status: 'paused',
      });
    } catch {}

    this._emitProgress(true);
    this._setState('paused');
  }

  /**
   * Cancels the download, closes/discards files, and marks cancelled.
   * @param {boolean} [deletePartial=false]
   */
  async cancel(deletePartial = false) {
    if (this.state === 'cancelled' || this.state === 'cancelling') return;

    this._setState('cancelling');

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.abortFn) {
      this.abortFn();
      this.abortFn = null;
    }

    if (this._executionPromise) {
      await this._executionPromise.catch(() => {});
      this._executionPromise = null;
    }

    if (this.writer) {
      try {
        if (deletePartial) {
          await this.writer.discard();
          this.downloadedBytes = 0;
        } else {
          const persisted = await this.writer.close();
          this.downloadedBytes = persisted;
        }
      } catch (err) {
        this.logger.error(`Task #${this.id} error on cancel:`, err);
      }
    }

    this.speedTracker.reset();

    try {
      this.repo.updateProgress(this.id, {
        downloaded_bytes: this.downloadedBytes,
        total_bytes: this.totalBytes,
        status: 'canceled',
      });
    } catch {}

    this._emitProgress(true);
    this._setState('cancelled');
  }

  /**
   * Handles stream or execution errors with automated retry policy.
   */
  async _handleExecutionError(err) {
    this.abortFn = null;

    if (this.state === 'pausing' || this.state === 'paused' || this.state === 'cancelling' || this.state === 'cancelled') {
      return;
    }

    this.logger.warn(`Task #${this.id} execution failed:`, err);

    if (this.writer) {
      try {
        const persisted = await this.writer.close();
        this.downloadedBytes = persisted;
      } catch {}
    }

    if (this.state === 'pausing' || this.state === 'paused' || this.state === 'cancelling' || this.state === 'cancelled') {
      return;
    }

    // Assess retry
    const retryCount = this.record.retry_count || 0;
    const retryAssess = RetryManager.assessRetry({
      retryCount,
      error: err,
      statusCode: err.statusCode || null,
      headers: err.headers || null,
    });

    if (retryAssess.shouldRetry) {
      try {
        this.repo.incrementRetry(this.id, err.code || 'ERR_DOWNLOAD', err.message);
      } catch {}
      this.record.retry_count = retryCount + 1;
      this._setState('retrying', { retryCount: this.record.retry_count, nextRetryMs: retryAssess.delayMs });

      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.state === 'retrying') {
          this.start().catch((e) => this._handleExecutionError(e));
        }
      }, retryAssess.delayMs);
    } else {
      this._setState('failed', {
        errorCode: err.code || 'DOWNLOAD_FAILED',
        errorMessage: err.message || 'Download failed.',
      });
    }
  }

  /**
   * Manually retries a failed or paused download.
   */
  retry() {
    this.repo.resetRetry(this.id);
    this.record.retry_count = 0;
    return this.start();
  }

  /**
   * Telemetry snapshot.
   */
  getTelemetry() {
    const now = Date.now();
    return {
      id: this.id,
      state: this.state,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      speedBps: this.isRunning ? this.speedTracker.getCurrentSpeed(now) : 0,
      avgSpeedBps: this.isRunning ? this.speedTracker.getAverageSpeed(now) : 0,
      etaSeconds: this.isRunning ? this.speedTracker.getEta(this.totalBytes, this.downloadedBytes) : null,
      retryCount: this.record.retry_count || 0,
    };
  }
}

module.exports = { DownloadTask };
