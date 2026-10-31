'use strict';

const RECOVERABLE_NODE_ERRORS = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

const RECOVERABLE_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504]);

const DEFAULT_MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_BACKOFF_MS = 60000;

/**
 * Manages bounded retries, exponential backoff, Retry-After header parsing,
 * and error classification.
 */
class RetryManager {
  /**
   * Assesses if an error or status is recoverable and determines the retry delay.
   *
   * @param {object} opts
   * @param {number} opts.retryCount current retry attempt number (0-indexed)
   * @param {Error|object} [opts.error] Error object or failure details
   * @param {number} [opts.statusCode] HTTP status code if available
   * @param {object} [opts.headers] response headers if available
   * @param {number} [opts.maxRetries=5]
   * @returns {{ shouldRetry: boolean, delayMs: number, reason: string }}
   */
  static assessRetry({ retryCount, error = null, statusCode = null, headers = null, maxRetries = DEFAULT_MAX_RETRIES }) {
    if (retryCount >= maxRetries) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: `Maximum retry limit (${maxRetries}) reached.`,
      };
    }

    const isRecoverable = RetryManager.isRecoverable(error, statusCode);
    if (!isRecoverable) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: 'Encountered non-recoverable error.',
      };
    }

    // Check for Retry-After header
    const retryAfterDelay = RetryManager.parseRetryAfter(headers);
    if (retryAfterDelay !== null) {
      const delayMs = Math.min(MAX_BACKOFF_MS, Math.max(1000, retryAfterDelay));
      return {
        shouldRetry: true,
        delayMs,
        reason: `Retrying after server-requested delay (${Math.round(delayMs / 1000)}s).`,
      };
    }

    // Exponential backoff with slight jitter to prevent thundering herds
    const exp = Math.min(MAX_BACKOFF_MS, BASE_DELAY_MS * Math.pow(2, retryCount));
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = Math.min(MAX_BACKOFF_MS, exp + jitter);

    return {
      shouldRetry: true,
      delayMs,
      reason: `Retrying in ${Math.round(delayMs / 1000)}s (attempt ${retryCount + 1}/${maxRetries}).`,
    };
  }

  /**
   * Returns true if error or status code is transient/recoverable.
   */
  static isRecoverable(error, statusCode) {
    if (statusCode && RECOVERABLE_HTTP_CODES.has(statusCode)) {
      return true;
    }

    if (error) {
      if (error.code && RECOVERABLE_NODE_ERRORS.has(error.code)) {
        return true;
      }
      const msg = String(error.message || '').toLowerCase();
      if (msg.includes('timeout') || msg.includes('reset') || msg.includes('socket hung up') || msg.includes('premature close')) {
        return true;
      }
    }

    return false;
  }

  /**
   * Parses standard HTTP Retry-After header (seconds or HTTP Date).
   * @param {object} headers
   * @returns {number|null} delay in milliseconds, or null
   */
  static parseRetryAfter(headers) {
    if (!headers) return null;
    const raw = headers['retry-after'] || headers['Retry-After'];
    if (!raw) return null;

    // Check integer seconds
    const seconds = Number.parseInt(raw, 10);
    if (!Number.isNaN(seconds) && seconds >= 0) {
      return seconds * 1000;
    }

    // Check HTTP Date
    const targetTime = Date.parse(raw);
    if (!Number.isNaN(targetTime)) {
      const diff = targetTime - Date.now();
      return diff > 0 ? diff : 0;
    }

    return null;
  }
}

module.exports = { RetryManager, DEFAULT_MAX_RETRIES };
