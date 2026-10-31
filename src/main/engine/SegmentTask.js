'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HttpClient } = require('./HttpClient');
const { DownloadValidator } = require('./DownloadValidator');

const MAX_SEGMENT_RETRIES = 5;
const MAX_BACKOFF_MS = 60000;
const PROGRESS_THROTTLE_MS = 150;

/**
 * Manages downloading an isolated byte range for a single segment of a file.
 */
class SegmentTask extends EventEmitter {
  /**
   * @param {object} opts
   * @param {number} opts.id segment database ID
   * @param {number} opts.downloadId parent download ID
   * @param {number} opts.segmentIndex zero-based index
   * @param {number} opts.startByte absolute start byte offset in file
   * @param {number} opts.endByte absolute end byte offset in file (inclusive)
   * @param {number} opts.expectedBytes length of this segment in bytes
   * @param {number} [opts.downloadedBytes=0] initial progress
   * @param {string} opts.temporaryPath path to .part file on disk
   * @param {string} opts.sourceUrl remote URL
   * @param {number} opts.totalFileSize complete remote file size
   * @param {string} [opts.etag] resource ETag for consistency checking
   * @param {string} [opts.lastModified] resource Last-Modified header
   * @param {import('../db/segments-repo').SegmentsRepo} opts.repo segments repository
   * @param {object} [opts.logger] logger
   */
  constructor({
    id,
    downloadId,
    segmentIndex,
    startByte,
    endByte,
    expectedBytes,
    downloadedBytes = 0,
    temporaryPath,
    sourceUrl,
    totalFileSize,
    etag = null,
    lastModified = null,
    repo,
    logger,
  }) {
    super();

    this.id = id;
    this.downloadId = downloadId;
    this.segmentIndex = segmentIndex;
    this.startByte = startByte;
    this.endByte = endByte;
    this.expectedBytes = expectedBytes;
    this.downloadedBytes = downloadedBytes;
    this.temporaryPath = path.resolve(temporaryPath);
    this.sourceUrl = sourceUrl;
    this.totalFileSize = totalFileSize;
    this.etag = etag;
    this.lastModified = lastModified;
    this.repo = repo;
    this.logger = logger || { info() {}, warn() {}, error() {} };

    this.status = 'pending';
    this.retryCount = 0;
    this.abortFn = null;
    this.fileStream = null;
    this.retryTimer = null;
    this.lastProgressEmit = 0;
    this.isDisposed = false;
  }

  /**
   * Starts or resumes segment download.
   */
  async start() {
    if (this.status === 'downloading' || this.isDisposed) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this._execute();
  }

  /**
   * Internal execution pipeline for this segment.
   */
  async _execute() {
    if (this.isDisposed) return;

    // Ensure parent directory exists
    const dir = path.dirname(this.temporaryPath);
    fs.mkdirSync(dir, { recursive: true });

    // Inspect disk state for resume viability
    let diskBytes = 0;
    if (fs.existsSync(this.temporaryPath)) {
      try {
        diskBytes = fs.statSync(this.temporaryPath).size;
      } catch {
        diskBytes = 0;
      }
    }

    // If segment already fully downloaded on disk, verify and mark completed
    if (diskBytes === this.expectedBytes) {
      this.downloadedBytes = this.expectedBytes;
      this._setStatus('completed');
      this.emit('completed', { segmentIndex: this.segmentIndex, downloadedBytes: this.expectedBytes });
      return;
    }

    // If disk file is oversized or corrupted, truncate it
    let append = false;
    let rangeStart = this.startByte;

    if (diskBytes > 0 && diskBytes < this.expectedBytes) {
      append = true;
      rangeStart = this.startByte + diskBytes;
      this.downloadedBytes = diskBytes;
    } else if (diskBytes > this.expectedBytes) {
      try { fs.truncateSync(this.temporaryPath, 0); } catch {}
      diskBytes = 0;
      this.downloadedBytes = 0;
    }

    const rangeHeader = `bytes=${rangeStart}-${this.endByte}`;
    this.logger.info(`Segment #${this.segmentIndex} (download #${this.downloadId}) starting: Range ${rangeHeader}`);

    this._setStatus('downloading');

    let streamRes;
    try {
      streamRes = await HttpClient.getStream(this.sourceUrl, {
        headers: { Range: rangeHeader },
      });
    } catch (netErr) {
      this._handleFailure(netErr);
      return;
    }

    this.abortFn = streamRes.abort;

    if (this.status !== 'downloading' || this.isDisposed) {
      if (this.abortFn) this.abortFn();
      return;
    }

    const { statusCode, headers, response } = streamRes;

    // Validate HTTP Status Code: Multi-segment MUST receive 206 Partial Content
    if (statusCode !== 206) {
      response.destroy();
      const err = new Error(`Server returned HTTP ${statusCode} for segment range ${rangeHeader} (expected 206)`);
      err.code = `HTTP_${statusCode}`;
      err.recoverable = statusCode >= 500 || statusCode === 429 || statusCode === 408;
      this._handleFailure(err);
      return;
    }

    // Validate Content-Range header
    const contentRange = headers['content-range'] || headers['Content-Range'] || '';
    const crCheck = DownloadValidator.parseContentRange(contentRange, rangeStart);
    if (!crCheck.valid) {
      response.destroy();
      const err = new Error(`Invalid Content-Range returned for segment ${this.segmentIndex}: ${contentRange} (${crCheck.error})`);
      err.code = 'INVALID_CONTENT_RANGE';
      err.recoverable = true;
      this._handleFailure(err);
      return;
    }

    // Validate resource identity consistency (if ETag provided)
    if (this.etag && headers['etag']) {
      const serverEtag = headers['etag'].replace(/^W\//, '').trim();
      const expectedEtag = this.etag.replace(/^W\//, '').trim();
      if (serverEtag !== expectedEtag) {
        response.destroy();
        const err = new Error(`Resource identity changed during segment download (ETag mismatch: ${serverEtag} != ${expectedEtag})`);
        err.code = 'ETAG_MISMATCH';
        err.recoverable = false;
        this._handleFailure(err);
        return;
      }
    }

    // Open file stream for writing with backpressure handling
    const openFlags = append ? 'a' : 'w';
    this.fileStream = fs.createWriteStream(this.temporaryPath, { flags: openFlags, highWaterMark: 64 * 1024 });

    let writeErrorOccurred = false;

    this.fileStream.on('error', (err) => {
      writeErrorOccurred = true;
      try { response.destroy(); } catch {}
      this._handleFailure(new Error(`Disk write error on segment ${this.segmentIndex}: ${err.message}`));
    });

    const onData = (chunk) => {
      if (this.status !== 'downloading' || writeErrorOccurred) return;

      const ok = this.fileStream.write(chunk);
      this.downloadedBytes += chunk.length;

      this._emitProgress();

      if (!ok) {
        response.pause();
        this.fileStream.once('drain', () => {
          if (this.status === 'downloading' && !writeErrorOccurred) {
            response.resume();
          }
        });
      }
    };

    response.on('data', onData);

    response.on('error', (err) => {
      if (writeErrorOccurred) return;
      this._cleanupStreams();
      this._handleFailure(err);
    });

    response.on('end', async () => {
      if (writeErrorOccurred) return;

      await new Promise((resolve) => {
        if (!this.fileStream || this.fileStream.closed) return resolve();
        this.fileStream.end(resolve);
      });

      this.fileStream = null;
      this.abortFn = null;

      // Verify on-disk byte count
      let actualSize = 0;
      try {
        actualSize = fs.statSync(this.temporaryPath).size;
      } catch {}

      if (actualSize !== this.expectedBytes) {
        const err = new Error(`Segment ${this.segmentIndex} size mismatch: downloaded ${actualSize} bytes, expected ${this.expectedBytes}`);
        err.code = 'SEGMENT_SIZE_MISMATCH';
        err.recoverable = true;
        this._handleFailure(err);
        return;
      }

      this.downloadedBytes = actualSize;
      this._setStatus('completed');
      this.emit('completed', { segmentIndex: this.segmentIndex, downloadedBytes: this.expectedBytes });
    });
  }

  /**
   * Emits throttled progress updates and updates database periodically.
   */
  _emitProgress(force = false) {
    const now = Date.now();
    if (!force && now - this.lastProgressEmit < PROGRESS_THROTTLE_MS) return;
    this.lastProgressEmit = now;

    if (this.repo) {
      try {
        this.repo.updateProgress(this.id, this.downloadedBytes);
      } catch {}
    }

    this.emit('progress', {
      segmentIndex: this.segmentIndex,
      downloadedBytes: this.downloadedBytes,
      expectedBytes: this.expectedBytes,
    });
  }

  /**
   * Safely updates segment status in memory and SQLite.
   */
  _setStatus(status, extra = {}) {
    this.status = status;
    if (this.repo) {
      try {
        this.repo.updateStatus(this.id, status, {
          ...extra,
          downloaded_bytes: this.downloadedBytes,
        });
      } catch {}
    }
    this.emit('status-changed', { segmentIndex: this.segmentIndex, status, extra });
  }

  /**
   * Evaluates failures, executes exponential backoff, or marks failed.
   */
  _handleFailure(err) {
    this._cleanupStreams();

    if (this.status === 'paused' || this.isDisposed) return;

    this.logger.warn(`Segment #${this.segmentIndex} failed (attempt ${this.retryCount + 1}/${MAX_SEGMENT_RETRIES}): ${err.message}`);

    const isRecoverable = err.recoverable !== false;
    if (!isRecoverable || this.retryCount >= MAX_SEGMENT_RETRIES) {
      this._setStatus('failed', { error_code: err.code || 'SEGMENT_ERROR', error_message: err.message });
      this.emit('failed', { segmentIndex: this.segmentIndex, error: err });
      return;
    }

    this.retryCount++;
    if (this.repo) {
      try {
        this.repo.resetForRetry(this.id, err.code || 'RETRYING', err.message);
      } catch {}
    }

    // Exponential backoff with full jitter
    const baseDelay = Math.min(MAX_BACKOFF_MS, 500 * (2 ** this.retryCount));
    const jitteredDelay = Math.round(baseDelay * (0.5 + 0.5 * Math.random()));

    this.logger.info(`Retrying segment #${this.segmentIndex} in ${jitteredDelay}ms...`);
    this._setStatus('pending', { error_code: 'RETRY_SCHEDULED', error_message: `Retrying in ${Math.round(jitteredDelay / 1000)}s` });

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._execute();
    }, jitteredDelay);
  }

  /**
   * Pauses the segment download cleanly and flushes buffers.
   */
  async pause() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.status === 'completed') return;

    if (this.abortFn) {
      this.abortFn();
      this.abortFn = null;
    }

    await this._flushFileStream();

    let diskBytes = 0;
    try {
      if (fs.existsSync(this.temporaryPath)) {
        diskBytes = fs.statSync(this.temporaryPath).size;
      }
    } catch {}

    this.downloadedBytes = diskBytes;
    this._setStatus('pending');
  }

  /**
   * Flushes file stream to ensure disk bytes are synchronized.
   */
  _flushFileStream() {
    return new Promise((resolve) => {
      if (!this.fileStream || this.fileStream.closed) return resolve();
      this.fileStream.end(() => {
        this.fileStream = null;
        resolve();
      });
    });
  }

  /**
   * Cancels segment download and cleans up.
   */
  async cancel(deletePartial = false) {
    this.isDisposed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.abortFn) {
      this.abortFn();
      this.abortFn = null;
    }

    await this._flushFileStream();

    if (deletePartial && fs.existsSync(this.temporaryPath)) {
      try { fs.unlinkSync(this.temporaryPath); } catch {}
    }
  }

  /**
   * Closes active network and disk streams.
   */
  _cleanupStreams() {
    if (this.abortFn) {
      try { this.abortFn(); } catch {}
      this.abortFn = null;
    }
    if (this.fileStream && !this.fileStream.closed) {
      try { this.fileStream.destroy(); } catch {}
      this.fileStream = null;
    }
  }
}

module.exports = { SegmentTask };
