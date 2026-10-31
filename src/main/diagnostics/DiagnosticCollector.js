'use strict';

const os = require('node:os');
const brand = require('../../shared/brand');
const { Sanitizer } = require('./Sanitizer');

/**
 * DiagnosticCollector
 * Collects strict allowlist-only diagnostic information without personal identifiable data.
 */
class DiagnosticCollector {
  /**
   * @param {object} ctx
   * @param {import('../db/database').BarqDatabase} ctx.database
   * @param {import('../db/downloads-repo').DownloadsRepo} ctx.downloadsRepo
   * @param {import('../db/downloads-repo').EventsRepo} [ctx.eventsRepo]
   * @param {import('../engine/DownloadManager')} [ctx.downloadManager]
   */
  constructor({ database, downloadsRepo, eventsRepo, downloadManager = null }) {
    this.database = database;
    this.downloadsRepo = downloadsRepo;
    this.eventsRepo = eventsRepo;
    this.downloadManager = downloadManager;
  }

  getSystemInfo() {
    let cpuCount = 1;
    try {
      const cpus = os.cpus();
      if (cpus && cpus.length) {
        cpuCount = cpus.length;
      }
    } catch {}

    return {
      osType: os.type(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
      freeMemoryMB: Math.round(os.freemem() / (1024 * 1024)),
      cpuCount,
      systemUptimeHours: Number((os.uptime() / 3600).toFixed(2)),
    };
  }

  getRuntimeInfo() {
    return {
      barqVersion: brand.VERSION || '0.1.0',
      electronVersion: process.versions.electron || 'node-test',
      nodeVersion: process.versions.node || 'unknown',
      chromeVersion: process.versions.chrome || 'none',
      v8Version: process.versions.v8 || 'unknown',
      schemaVersion: this.database ? this.database.userVersion : 0,
    };
  }

  getTelemetrySummary() {
    let summary = {
      totalDownloads: 0,
      activeTransfers: 0,
      queued: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      overallSpeedBps: 0,
    };

    if (this.database) {
      try {
        const counts = this.database.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END) as downloading,
            SUM(CASE WHEN status IN ('queued', 'scheduled') THEN 1 ELSE 0 END) as queued,
            SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) as paused,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
            SUM(CASE WHEN status IN ('failed', 'canceled') THEN 1 ELSE 0 END) as failed
          FROM downloads
        `).get();

        if (counts) {
          summary.totalDownloads = Number(counts.total) || 0;
          summary.queued = Number(counts.queued) || 0;
          summary.paused = Number(counts.paused) || 0;
          summary.completed = Number(counts.completed) || 0;
          summary.failed = Number(counts.failed) || 0;
        }
      } catch {}
    }

    if (this.downloadManager) {
      try {
        if (typeof this.downloadManager.getActiveCount === 'function') {
          summary.activeTransfers = this.downloadManager.getActiveCount();
        } else if (this.downloadManager.activeTasks) {
          summary.activeTransfers = this.downloadManager.activeTasks.size;
        }
        if (typeof this.downloadManager.getSpeedBps === 'function') {
          summary.overallSpeedBps = this.downloadManager.getSpeedBps();
        }
      } catch {}
    }

    return summary;
  }

  getSanitizedEvents(limit = 50) {
    if (!this.database) return [];
    try {
      const rawEvents = this.database.prepare(`
        SELECT id, level, type, message, created_at
        FROM events
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(Math.min(limit, 100));

      return rawEvents.map((evt) => ({
        id: evt.id,
        level: evt.level,
        type: evt.type,
        message: Sanitizer.scrubText(evt.message),
        created_at: evt.created_at,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Generates complete preview bundle for user inspection.
   */
  collectDiagnosticBundle(opts = {}) {
    return {
      collectedAt: new Date().toISOString(),
      privacyNotice: 'Zero telemetry policy: BARQ Downloader does not transmit data automatically. This diagnostic bundle is exported strictly upon your explicit action.',
      system: this.getSystemInfo(),
      runtime: this.getRuntimeInfo(),
      telemetry: this.getTelemetrySummary(),
      recentLogs: this.getSanitizedEvents(opts.logLimit || 50),
    };
  }
}

module.exports = { DiagnosticCollector };
