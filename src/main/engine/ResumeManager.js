'use strict';

const fs = require('node:fs');
const { DownloadValidator } = require('./DownloadValidator');

/**
 * Manages HTTP Range requests, partial file validation, and safe resume semantics.
 */
class ResumeManager {
  /**
   * Inspects partial file on disk and database record to assess resume viability.
   *
   * @param {object} record database download record
   * @param {string} partialPath path to `.barq-part` file
   * @returns {{ canAttemptResume: boolean, actualBytes: number, reason: string }}
   */
  static assessResume(record, partialPath) {
    if (!partialPath || !fs.existsSync(partialPath)) {
      return { canAttemptResume: false, actualBytes: 0, reason: 'Partial file not found on disk.' };
    }

    let stat;
    try {
      stat = fs.statSync(partialPath);
    } catch (err) {
      return { canAttemptResume: false, actualBytes: 0, reason: `Failed to read partial file: ${err.message}` };
    }

    const actualBytes = stat.size;
    if (actualBytes <= 0) {
      return { canAttemptResume: false, actualBytes: 0, reason: 'Partial file is empty.' };
    }

    if (record.total_bytes && actualBytes > record.total_bytes) {
      return { canAttemptResume: false, actualBytes, reason: 'Partial file size exceeds expected total file size.' };
    }

    if (record.supports_ranges === 0) {
      return { canAttemptResume: false, actualBytes, reason: 'Remote server does not advertise Range request support.' };
    }

    return {
      canAttemptResume: true,
      actualBytes,
      reason: `Found ${actualBytes} verified partial bytes on disk.`,
    };
  }

  /**
   * Evaluates server response to a Range request and dictates how the writer must open.
   *
   * @param {object} opts
   * @param {number} opts.statusCode HTTP response status
   * @param {object} opts.headers response headers
   * @param {number} opts.requestedOffset byte offset that was requested
   * @param {object} opts.previousRecord previous database record (etag, last_modified, total_bytes)
   * @returns {{ action: 'append'|'restart'|'complete'|'error', startOffset: number, error?: string, reason?: string }}
   */
  static evaluateResumeResponse({ statusCode, headers, requestedOffset, previousRecord }) {
    // 1. Verify resource identity (has the file changed on server?)
    const identity = DownloadValidator.verifyResourceIdentity(previousRecord, headers);
    if (!identity.match) {
      return {
        action: 'restart',
        startOffset: 0,
        reason: `Server file changed (${identity.reason}). Restarting from beginning to prevent corruption.`,
      };
    }

    // 2. HTTP 206 Partial Content (Normal successful Range response)
    if (statusCode === 206) {
      const contentRange = headers['content-range'] || headers['Content-Range'];
      const parsedCr = DownloadValidator.parseContentRange(contentRange, requestedOffset);

      if (!parsedCr.valid) {
        return {
          action: 'restart',
          startOffset: 0,
          reason: `Invalid Content-Range returned by server: ${parsedCr.error}. Restarting safely.`,
        };
      }

      return {
        action: 'append',
        startOffset: parsedCr.start,
        totalBytes: parsedCr.total,
        reason: `Resumed from byte ${parsedCr.start}.`,
      };
    }

    // 3. HTTP 200 OK (Server ignored Range header or does not support ranges)
    if (statusCode === 200) {
      return {
        action: 'restart',
        startOffset: 0,
        reason: 'Server ignored Range header and returned full content (HTTP 200). Restarting safely without corrupting append.',
      };
    }

    // 4. HTTP 416 Range Not Satisfiable
    if (statusCode === 416) {
      if (previousRecord.total_bytes && requestedOffset >= previousRecord.total_bytes) {
        return {
          action: 'complete',
          startOffset: requestedOffset,
          reason: 'Partial file on disk matches or exceeds total file size (HTTP 416). File already complete.',
        };
      }
      return {
        action: 'restart',
        startOffset: 0,
        reason: 'Requested Range out of bounds (HTTP 416). Restarting download from beginning.',
      };
    }

    // 5. Any other error status
    return {
      action: 'error',
      startOffset: requestedOffset,
      error: `Server rejected resume with HTTP status ${statusCode}.`,
    };
  }
}

module.exports = { ResumeManager };
