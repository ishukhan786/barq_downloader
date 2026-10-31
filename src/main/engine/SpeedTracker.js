'use strict';

/**
 * Tracks download throughput, calculates rolling instantaneous speed,
 * session average speed, and estimated time of arrival (ETA).
 */
class SpeedTracker {
  /**
   * @param {object} [opts]
   * @param {number} [opts.windowMs=1500] duration of rolling sample window
   */
  constructor({ windowMs = 1500 } = {}) {
    this.windowMs = windowMs;
    this.samples = []; // array of { time: number, bytes: number }
    this.sessionStart = null;
    this.sessionStartBytes = 0;
    this.lastBytes = 0;
  }

  /**
   * Starts or resumes tracking session.
   * @param {number} initialBytes
   */
  start(initialBytes = 0) {
    const now = Date.now();
    this.sessionStart = now;
    this.sessionStartBytes = initialBytes;
    this.lastBytes = initialBytes;
    this.samples = [{ time: now, bytes: initialBytes }];
  }

  /**
   * Records newly downloaded bytes count at current timestamp.
   * @param {number} currentTotalBytes
   * @param {number} [now=Date.now()]
   */
  record(currentTotalBytes, now = Date.now()) {
    if (this.sessionStart === null) {
      this.start(currentTotalBytes);
      return;
    }

    this.lastBytes = currentTotalBytes;
    this.samples.push({ time: now, bytes: currentTotalBytes });

    // Prune samples older than rolling window
    const cutoff = now - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].time < cutoff) {
      this.samples.shift();
    }
  }

  /**
   * Instantaneous speed in bytes per second across the rolling window.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getCurrentSpeed(now = Date.now()) {
    if (this.samples.length < 2) return 0;

    const newest = this.samples[this.samples.length - 1];
    const oldest = this.samples[0];

    const elapsedMs = newest.time - oldest.time;
    if (elapsedMs <= 0) return 0;

    // If no data arrived in twice the window duration, speed has dropped to 0
    if (now - newest.time > this.windowMs * 2) {
      return 0;
    }

    const deltaBytes = newest.bytes - oldest.bytes;
    if (deltaBytes <= 0) return 0;

    const speed = (deltaBytes / elapsedMs) * 1000;
    return Number.isFinite(speed) && speed > 0 ? speed : 0;
  }

  /**
   * Average speed across the active session in bytes per second.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getAverageSpeed(now = Date.now()) {
    if (!this.sessionStart || now <= this.sessionStart) return 0;
    const elapsedSec = (now - this.sessionStart) / 1000;
    if (elapsedSec <= 0) return 0;

    const delta = this.lastBytes - this.sessionStartBytes;
    if (delta <= 0) return 0;

    const avg = delta / elapsedSec;
    return Number.isFinite(avg) && avg > 0 ? avg : 0;
  }

  /**
   * Estimated remaining time in seconds.
   * Returns null if totalBytes is unknown, already complete, or speed is 0.
   *
   * @param {number|null} totalBytes
   * @param {number} currentBytes
   * @param {number} [speedBps]
   * @returns {number|null}
   */
  getEta(totalBytes, currentBytes, speedBps = this.getCurrentSpeed()) {
    if (totalBytes === null || totalBytes === undefined || !Number.isFinite(totalBytes) || totalBytes <= 0) {
      return null;
    }
    const remaining = totalBytes - currentBytes;
    if (remaining <= 0) return 0;
    if (!speedBps || speedBps <= 0) return null;

    const eta = remaining / speedBps;
    return Number.isFinite(eta) && eta >= 0 ? eta : null;
  }

  /**
   * Resets tracking state.
   */
  reset() {
    this.samples = [];
    this.sessionStart = null;
    this.sessionStartBytes = 0;
    this.lastBytes = 0;
  }
}

module.exports = { SpeedTracker };
