'use strict';

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { SegmentTask } = require('./SegmentTask');
const { SegmentMerger } = require('./SegmentMerger');
const { SpeedTracker } = require('./SpeedTracker');
const { RangeSupportDetector } = require('./RangeSupportDetector');

const PROGRESS_THROTTLE_MS = 150;

/**
 * Orchestrates multi-segment parallel downloads, managing connection workers,
 * progress aggregation, individual segment retries, and sequential merging.
 */
class SegmentedDownloadTask extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.id download database ID
   * @param {object} opts.record download record from SQLite
   * @param {import('../db/downloads-repo').DownloadsRepo} opts.downloadsRepo
   * @param {import('../db/segments-repo').SegmentsRepo} opts.segmentsRepo
   * @param {number} [opts.connectionsPerFile=8] max parallel segment workers
   * @param {string} [opts.expectedHash] optional SHA-256 for verification
   * @param {boolean} [opts.autoFallback=true] fallback to single connection if segmented fails
   * @param {object} [opts.logger] logger
   */
  constructor({
    id,
    record,
    downloadsRepo,
    segmentsRepo,
    connectionsPerFile = 8,
    expectedHash = null,
    autoFallback = true,
    logger = null,
  }) {
    super();

    this.id = id;
    this.record = record;
    this.downloadsRepo = downloadsRepo;
    this.segmentsRepo = segmentsRepo;
    this.connectionsPerFile = Math.max(1, Math.min(16, connectionsPerFile));
    this.expectedHash = expectedHash;
    this.autoFallback = autoFallback;
    this.logger = logger || { info() {}, warn() {}, error() {} };

    this.isSegmented = true;
    this.state = record.status || 'queued';
    this.downloadedBytes = record.downloaded_bytes || 0;
    this.totalBytes = record.total_bytes;

    this.segmentWorkers = new Map(); // segmentIndex -> SegmentTask
    this.speedTracker = new SpeedTracker();
    this.lastProgressEmit = 0;
    this.isDisposed = false;
    this._isMerging = false;
  }

  get isRunning() {
    return this.state === 'downloading';
  }

  /**
   * Starts parallel segment execution.
   */
  async start() {
    if (this.state === 'downloading' || this.isDisposed || this._isMerging) return;

    this._setState('downloading');
    this.speedTracker.start(this.downloadedBytes);

    try {
      await this._launchWorkers();
    } catch (err) {
      await this._handleTaskFailure(err);
    }
  }

  /**
   * Instantiates and launches SegmentTask workers up to connectionsPerFile concurrency.
   */
  async _launchWorkers() {
    const segmentRecords = this.segmentsRepo.getByDownloadId(this.id);
    if (!segmentRecords.length) {
      throw new Error(`No segment plan found for download #${this.id}`);
    }

    this.segmentWorkers.clear();

    const pendingOrIncomplete = [];

    for (const rec of segmentRecords) {
      const task = new SegmentTask({
        id: rec.id,
        downloadId: this.id,
        segmentIndex: rec.segment_index,
        startByte: rec.start_byte,
        endByte: rec.end_byte,
        expectedBytes: rec.end_byte - rec.start_byte + 1,
        downloadedBytes: rec.downloaded_bytes,
        temporaryPath: rec.temporary_path,
        sourceUrl: this.record.source_url,
        totalFileSize: this.totalBytes,
        etag: this.record.etag,
        lastModified: this.record.last_modified,
        repo: this.segmentsRepo,
        logger: this.logger,
      });

      task.on('progress', () => this._aggregateAndEmitProgress());
      task.on('completed', () => this._onSegmentCompleted(rec.segment_index));
      task.on('failed', ({ error }) => this._onSegmentFailed(rec.segment_index, error));

      this.segmentWorkers.set(rec.segment_index, task);

      if (rec.status !== 'completed') {
        pendingOrIncomplete.push(task);
      }
    }

    // If all segments already completed on disk, trigger merge immediately
    if (pendingOrIncomplete.length === 0) {
      this.logger.info(`All segments for download #${this.id} already complete. Starting merge...`);
      await this._finalizeAndMerge();
      return;
    }

    // Launch workers in parallel
    const launchBatch = pendingOrIncomplete.slice(0, this.connectionsPerFile);
    for (const worker of launchBatch) {
      worker.start().catch((err) => {
        this.logger.error(`Segment #${worker.segmentIndex} worker crashed on start:`, err);
      });
    }
  }

  /**
   * Called when an individual segment worker finishes.
   */
  async _onSegmentCompleted(segmentIndex) {
    this.logger.info(`Segment #${segmentIndex} for download #${this.id} finished successfully.`);
    this._aggregateAndEmitProgress(true);

    // Check if any other incomplete segments need to be launched
    for (const worker of this.segmentWorkers.values()) {
      if (worker.status === 'pending') {
        worker.start().catch(() => {});
        break;
      }
    }

    // Check if ALL segments are now completed
    const allCompleted = [...this.segmentWorkers.values()].every((w) => w.status === 'completed');
    if (allCompleted) {
      await this._finalizeAndMerge();
    }
  }

  /**
   * Called when a segment worker fails permanently.
   */
  async _onSegmentFailed(segmentIndex, error) {
    this.logger.error(`Segment #${segmentIndex} for download #${this.id} failed permanently:`, error);
    await this._handleTaskFailure(new Error(`Segment #${segmentIndex} failed: ${error.message}`));
  }

  /**
   * Merges segments sequentially in exact byte order, verifies file, and marks completed.
   */
  async _finalizeAndMerge() {
    if (this._isMerging) return;
    this._isMerging = true;

    try {
      this.logger.info(`Finalizing and merging segments for download #${this.id}...`);

      const segmentRecords = this.segmentsRepo.getByDownloadId(this.id);
      const mergeRes = await SegmentMerger.merge({
        segments: segmentRecords,
        destinationPath: this.record.destination_path,
        filename: this.record.filename,
        totalBytes: this.totalBytes,
        expectedHash: this.expectedHash,
        logger: this.logger,
      });

      this.downloadedBytes = mergeRes.finalSize;
      this._emitProgress(true);
      this._setState('completed', { completed_at: Date.now() });

      this.logger.info(`Download #${this.id} successfully completed and merged into ${mergeRes.finalPath}.`);
    } catch (mergeErr) {
      this._isMerging = false;
      this.logger.error(`Merge failed for download #${this.id}:`, mergeErr);
      this._setState('failed', {
        error_code: 'MERGE_FAILED',
        error_message: `Segment merge failed: ${mergeErr.message}`,
      });
      this.emit('state-changed', { id: this.id, state: 'failed', extra: { errorMessage: mergeErr.message } });
    }
  }

  /**
   * Computes aggregate downloaded bytes across all segments and emits throttled progress.
   */
  _aggregateAndEmitProgress(force = false) {
    let sum = 0;
    for (const worker of this.segmentWorkers.values()) {
      sum += worker.downloadedBytes;
    }
    this.downloadedBytes = sum;

    const now = Date.now();
    if (!force && now - this.lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    this.lastProgressEmit = now;

    this._emitProgress(force);
  }

  _emitProgress(force = false) {
    const now = Date.now();
    const currentSpeed = this.speedTracker.getCurrentSpeed(now);
    const avgSpeed = this.speedTracker.getAverageSpeed(now);
    const eta = this.speedTracker.getEta(this.totalBytes, this.downloadedBytes, currentSpeed);

    // Save progress periodically to database
    try {
      this.downloadsRepo.updateProgress(this.id, {
        downloaded_bytes: this.downloadedBytes,
        total_bytes: this.totalBytes,
        status: this.state,
      });
    } catch {}

    const telemetry = this.getTelemetry();

    this.emit('progress', {
      id: this.id,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      currentSpeed,
      avgSpeed,
      etaSeconds: eta,
      state: this.state,
      ...telemetry,
    });
  }

  /**
   * Returns current multi-segment telemetry for UI.
   */
  getTelemetry() {
    let completedCount = 0;
    let activeCount = 0;
    const segmentList = [];

    for (const worker of this.segmentWorkers.values()) {
      if (worker.status === 'completed') completedCount++;
      if (worker.status === 'downloading') activeCount++;
      segmentList.push({
        index: worker.segmentIndex,
        start: worker.startByte,
        end: worker.endByte,
        downloaded: worker.downloadedBytes,
        expected: worker.expectedBytes,
        status: worker.status,
      });
    }

    return {
      isSegmented: true,
      totalSegments: this.segmentWorkers.size,
      completedSegments: completedCount,
      activeSegments: activeCount,
      connectionCount: Math.min(this.connectionsPerFile, this.segmentWorkers.size),
      segments: segmentList,
    };
  }

  /**
   * Pauses all segment workers, flushes buffers, and sets status to paused.
   */
  async pause() {
    if (this.state === 'paused' || this.state === 'pausing') return;
    this._setState('pausing');

    const pausePromises = [];
    for (const worker of this.segmentWorkers.values()) {
      pausePromises.push(worker.pause());
    }
    await Promise.allSettled(pausePromises);

    this._aggregateAndEmitProgress(true);
    this._setState('paused');
    this.logger.info(`Multi-segment download #${this.id} paused safely.`);
  }

  /**
   * Resumes paused segmented download with pre-resume resource identity check.
   */
  async resume() {
    if (this.state === 'downloading' || this._isMerging) return;

    this.logger.info(`Resuming segmented download #${this.id}...`);

    // Verify remote Range support and identity before resuming
    const probe = await RangeSupportDetector.detect(this.record.source_url, {
      autoSegmentation: true,
      minSegmentSize: 0, // don't reject on resume
    });

    if (!probe.supportsRanges) {
      this.logger.warn(`Server no longer supports Range requests on resume for #${this.id}. Triggering fallback.`);
      this.emit('fallback-needed', { id: this.id, reason: probe.reason });
      return;
    }

    // Verify resource identity consistency
    if (this.record.etag && probe.etag) {
      const oldEtag = this.record.etag.replace(/^W\//, '').trim();
      const newEtag = probe.etag.replace(/^W\//, '').trim();
      if (oldEtag !== newEtag) {
        this.logger.warn(`Resource ETag changed on resume for #${this.id}. Triggering fallback restart.`);
        this.emit('fallback-needed', { id: this.id, reason: 'Remote resource identity changed (ETag mismatch)' });
        return;
      }
    }

    await this.start();
  }

  /**
   * Cancels download and stops all workers.
   */
  async cancel(deletePartial = false) {
    this.isDisposed = true;
    this._setState('cancelling');

    const cancelPromises = [];
    for (const worker of this.segmentWorkers.values()) {
      cancelPromises.push(worker.cancel(deletePartial));
    }
    await Promise.allSettled(cancelPromises);

    if (deletePartial) {
      try {
        const partsDir = `${this.record.destination_path}/${this.record.filename}.barq-parts`;
        if (fs.existsSync(partsDir)) {
          fs.rmSync(partsDir, { recursive: true, force: true });
        }
      } catch {}
    }

    this._setState('canceled');
  }

  /**
   * Retries failed segmented download.
   */
  async retry() {
    this.isDisposed = false;
    this.downloadsRepo.resetRetry(this.id);
    await this.resume();
  }

  /**
   * Handles task failure and evaluates fallback.
   */
  async _handleTaskFailure(err) {
    this.logger.error(`SegmentedDownloadTask #${this.id} failed:`, err);

    for (const worker of this.segmentWorkers.values()) {
      try { await worker.pause(); } catch {}
    }

    if (this.autoFallback) {
      this.logger.info(`Triggering single-connection fallback for #${this.id}...`);
      this.emit('fallback-needed', { id: this.id, reason: err.message });
      return;
    }

    this._setState('failed', {
      error_code: err.code || 'SEGMENT_ERROR',
      error_message: err.message,
    });
    this.emit('state-changed', { id: this.id, state: 'failed', extra: { errorMessage: err.message } });
  }

  _setState(state, extra = {}) {
    this.state = state;
    if (this.record) {
      this.record.status = state;
    }
    try {
      this.downloadsRepo.updateStatus(this.id, state, extra);
    } catch {}
    this.emit('state-changed', { id: this.id, state, extra });
  }
}

module.exports = { SegmentedDownloadTask };
