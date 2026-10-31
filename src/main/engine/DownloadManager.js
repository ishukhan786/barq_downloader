'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');
const { DownloadTask } = require('./DownloadTask');
const { HttpClient } = require('./HttpClient');
const { FilenameResolver } = require('./FilenameResolver');
const { categorize } = require('../../shared/categories');

/**
 * DownloadManager coordinates concurrency, task lifecycles,
 * startup recovery, and telemetry dispatch.
 */
class DownloadManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../db/downloads-repo').DownloadsRepo} opts.downloadsRepo
   * @param {import('../db/settings-repo').SettingsRepo} opts.settingsRepo
   * @param {import('../db/downloads-repo').EventsRepo} opts.eventsRepo
   * @param {import('../logger').createLogger} opts.logger
   * @param {(channel: string, payload: any) => void} [opts.broadcast]
   */
  constructor({ downloadsRepo, settingsRepo, eventsRepo, logger, broadcast = null }) {
    super();
    this.repo = downloadsRepo;
    this.settings = settingsRepo;
    this.events = eventsRepo;
    this.logger = logger;
    this.broadcast = broadcast || (() => {});

    this.tasks = new Map(); // id -> DownloadTask
  }

  /**
   * Initializes the download manager and recovers any downloads interrupted
   * by previous crash or application closure.
   */
  async init() {
    this.logger.info('Initializing BARQ Download Manager...');
    await this.recoverInterrupted();
  }

  /**
   * Scans SQLite for unfinished downloads (status = 'downloading' or 'queued'),
   * reconciles disk partial files with database progress, and marks them safely paused.
   */
  async recoverInterrupted() {
    try {
      const unfinished = this.repo.getUnfinished();
      if (!unfinished.length) return;

      this.logger.info(`Found ${unfinished.length} unfinished download(s) from previous run.`);

      for (const rec of unfinished) {
        const dest = rec.destination_path;
        const fn = rec.filename;
        const expectedPart = rec.partial_path || path.join(dest, `${fn}.barq-part`);

        let verifiedBytes = 0;
        if (fs.existsSync(expectedPart)) {
          try {
            verifiedBytes = fs.statSync(expectedPart).size;
          } catch {}
        }

        // Reconcile database state: mark as paused with actual verified bytes on disk
        this.repo.updateProgress(rec.id, {
          downloaded_bytes: verifiedBytes,
          total_bytes: rec.total_bytes,
          status: 'paused',
        });

        this.repo.updateStatus(rec.id, 'paused', {
          error_code: null,
          error_message: 'Paused automatically after application restart. Ready to resume.',
          partial_path: expectedPart,
        });

        this.events.add({
          downloadId: rec.id,
          level: 'info',
          type: 'recovered',
          message: `Interrupted download "${rec.filename}" recovered (${verifiedBytes} bytes on disk).`,
        });

        this.logger.info(`Recovered interrupted download #${rec.id} (${rec.filename}): ${verifiedBytes} bytes.`);
      }
    } catch (err) {
      this.logger.error('Error during restart recovery:', err);
    }
  }

  /**
   * Probes a remote URL without downloading the file.
   * @param {string} url
   * @returns {Promise<object>}
   */
  async probe(url) {
    return HttpClient.probe(url);
  }

  /**
   * Adds a new download to the engine.
   *
   * @param {object} params
   * @param {string} params.sourceUrl
   * @param {string} [params.filename]
   * @param {string} [params.destinationPath]
   * @param {boolean} [params.startNow=true]
   * @returns {Promise<object>} newly created database record
   */
  async add({ sourceUrl, filename = null, destinationPath = null, startNow = true }) {
    const defaultDir = this.settings.get('downloadDir') || process.cwd();
    const dest = destinationPath ? path.resolve(destinationPath) : defaultDir;

    // Ensure target folder exists
    fs.mkdirSync(dest, { recursive: true });

    // Derive or sanitize filename
    let finalName = filename;
    if (!finalName) {
      try {
        const probeRes = await this.probe(sourceUrl);
        finalName = probeRes.filename;
      } catch {
        finalName = FilenameResolver.fromUrl(sourceUrl, 'download');
      }
    }

    // Resolve collision in destination
    finalName = FilenameResolver.resolveUniqueFilename(dest, finalName);
    const cat = categorize(finalName);
    const partPath = path.join(dest, `${finalName}.barq-part`);

    // Insert to DB
    const id = this.repo.insert({
      source_url: sourceUrl,
      filename: finalName,
      destination_path: dest,
      status: 'queued',
      category: cat,
      partial_path: partPath,
    });

    const record = this.repo.getById(id);
    this.events.add({
      downloadId: id,
      type: 'added',
      message: `Added "${finalName}" to downloads (${startNow ? 'downloading' : 'queued'})`,
    });

    const task = this._createTask(record);

    if (startNow) {
      this._scheduleQueue();
    }

    return record;
  }

  /**
   * Internal factory for DownloadTask.
   */
  _createTask(record) {
    if (this.tasks.has(record.id)) {
      return this.tasks.get(record.id);
    }

    const task = new DownloadTask({
      id: record.id,
      record,
      repo: this.repo,
      logger: this.logger,
    });

    task.on('progress', (payload) => {
      this.broadcast('download:progress', payload);
    });

    task.on('state-changed', (payload) => {
      this.broadcast('download:state-changed', payload);
      this._scheduleQueue();
    });

    this.tasks.set(record.id, task);
    return task;
  }

  /**
   * Schedules queued downloads according to maxConcurrentDownloads setting.
   */
  _scheduleQueue() {
    const maxConcurrent = this.settings.get('maxConcurrentDownloads') || 3;
    let activeCount = 0;

    for (const task of this.tasks.values()) {
      if (task.isRunning) {
        activeCount++;
      }
    }

    if (activeCount >= maxConcurrent) return;

    // Find next queued task
    for (const task of this.tasks.values()) {
      if (activeCount >= maxConcurrent) break;

      if (task.state === 'pending' || task.state === 'queued' || (task.state === 'paused' && task.record.status === 'queued')) {
        activeCount++;
        task.start().catch((err) => {
          this.logger.error(`Failed to start task #${task.id}:`, err);
        });
      }
    }
  }

  /**
   * Pauses a download task.
   */
  async pause(id) {
    const task = this._getOrLoadTask(id);
    if (!task) throw new Error(`Download #${id} not found.`);
    await task.pause();
    this.events.add({ downloadId: id, type: 'paused', message: `Paused download "${task.record.filename}"` });
    return true;
  }

  /**
   * Resumes a download task.
   */
  async resume(id) {
    const task = this._getOrLoadTask(id);
    if (!task) throw new Error(`Download #${id} not found.`);
    await task.start();
    this.events.add({ downloadId: id, type: 'resumed', message: `Resumed download "${task.record.filename}"` });
    return true;
  }

  /**
   * Cancels a download task.
   */
  async cancel(id, deletePartial = false) {
    const task = this._getOrLoadTask(id);
    if (!task) throw new Error(`Download #${id} not found.`);
    await task.cancel(deletePartial);
    this.events.add({ downloadId: id, type: 'canceled', message: `Canceled download "${task.record.filename}"` });
    return true;
  }

  /**
   * Retries a failed download task.
   */
  async retry(id) {
    const task = this._getOrLoadTask(id);
    if (!task) throw new Error(`Download #${id} not found.`);
    await task.retry();
    this.events.add({ downloadId: id, type: 'retried', message: `Retrying download "${task.record.filename}"` });
    return true;
  }

  /**
   * Removes a download record from history.
   */
  async remove(id) {
    const task = this.tasks.get(id);
    if (task) {
      if (task.isRunning) {
        throw new Error('Pause or cancel the download before removing it.');
      }
      this.tasks.delete(id);
    }
    const rec = this.repo.getById(id);
    if (rec) {
      this.repo.remove(id);
    }
    return true;
  }

  /**
   * Gets or loads task from database.
   */
  _getOrLoadTask(id) {
    if (this.tasks.has(id)) {
      return this.tasks.get(id);
    }
    const rec = this.repo.getById(id);
    if (!rec) return null;
    return this._createTask(rec);
  }

  /**
   * Returns telemetry for a specific task.
   */
  getTelemetry(id) {
    const task = this.tasks.get(id);
    return task ? task.getTelemetry() : null;
  }

  /**
   * Calculates overall aggregate telemetry across all tasks.
   * @returns {{ overallSpeedBps: number, activeTransfers: number }}
   */
  getGlobalTelemetry() {
    let overallSpeedBps = 0;
    let activeTransfers = 0;

    for (const task of this.tasks.values()) {
      if (task.isRunning) {
        activeTransfers++;
        overallSpeedBps += task.speedTracker.getCurrentSpeed();
      }
    }

    return { overallSpeedBps, activeTransfers };
  }

  /**
   * Safely stops all active downloads on app exit.
   */
  async shutdown() {
    this.logger.info('Shutting down download manager...');
    const pauses = [];
    for (const task of this.tasks.values()) {
      if (task.retryTimer) {
        clearTimeout(task.retryTimer);
        task.retryTimer = null;
      }
      if (task.isRunning || task.state === 'retrying' || task.state === 'pausing') {
        pauses.push(task.pause());
      }
    }
    await Promise.allSettled(pauses);
  }
}

module.exports = { DownloadManager };
