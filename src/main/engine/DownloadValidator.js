'use strict';

/**
 * Validates HTTP response headers, status codes, Range assertions,
 * and completion integrity.
 */
class DownloadValidator {
  /**
   * Evaluates HTTP status code for file downloads.
   * @param {number} statusCode
   * @returns {{ ok: true, isPartial: boolean, isRedirect: boolean } | { ok: false, errorCode: string, errorMessage: string, recoverable: boolean }}
   */
  static validateStatus(statusCode) {
    if (statusCode === 200) {
      return { ok: true, isPartial: false, isRedirect: false };
    }
    if (statusCode === 206) {
      return { ok: true, isPartial: true, isRedirect: false };
    }
    if ([301, 302, 303, 307, 308].includes(statusCode)) {
      return { ok: true, isPartial: false, isRedirect: true };
    }

    // Standard HTTP error classifications
    switch (statusCode) {
      case 400:
        return { ok: false, errorCode: 'HTTP_400', errorMessage: 'Bad Request. The server rejected the request parameters.', recoverable: false };
      case 401:
        return { ok: false, errorCode: 'HTTP_401', errorMessage: 'Authorization Required. Credentials or login needed to access this file.', recoverable: false };
      case 403:
        return { ok: false, errorCode: 'HTTP_403', errorMessage: 'Access Forbidden. You do not have permission to download this resource.', recoverable: false };
      case 404:
        return { ok: false, errorCode: 'HTTP_404', errorMessage: 'File Not Found. The resource does not exist at this URL.', recoverable: false };
      case 408:
        return { ok: false, errorCode: 'HTTP_408', errorMessage: 'Request Timeout. The server timed out waiting for the request.', recoverable: true };
      case 416:
        return { ok: false, errorCode: 'HTTP_416', errorMessage: 'Range Not Satisfiable. The requested file offset is out of range.', recoverable: true };
      case 429:
        return { ok: false, errorCode: 'HTTP_429', errorMessage: 'Too Many Requests. Download rate limited by the server.', recoverable: true };
      case 500:
        return { ok: false, errorCode: 'HTTP_500', errorMessage: 'Internal Server Error. The remote host encountered an error.', recoverable: true };
      case 502:
        return { ok: false, errorCode: 'HTTP_502', errorMessage: 'Bad Gateway. Remote proxy or upstream server failed.', recoverable: true };
      case 503:
        return { ok: false, errorCode: 'HTTP_503', errorMessage: 'Service Unavailable. Server temporarily overloaded or down for maintenance.', recoverable: true };
      case 504:
        return { ok: false, errorCode: 'HTTP_504', errorMessage: 'Gateway Timeout. The upstream server did not respond in time.', recoverable: true };
      default:
        if (statusCode >= 400 && statusCode < 500) {
          return { ok: false, errorCode: `HTTP_${statusCode}`, errorMessage: `Client error HTTP ${statusCode}.`, recoverable: false };
        }
        if (statusCode >= 500) {
          return { ok: false, errorCode: `HTTP_${statusCode}`, errorMessage: `Server error HTTP ${statusCode}.`, recoverable: true };
        }
        return { ok: false, errorCode: `HTTP_${statusCode}`, errorMessage: `Unexpected HTTP status ${statusCode}.`, recoverable: false };
    }
  }

  /**
   * Parses and validates Content-Range header.
   * e.g., 'bytes 1048576-2097151/2097152'
   *
   * @param {string} contentRange
   * @param {number} [expectedStart]
   * @returns {{ valid: boolean, start: number, end: number, total: number|null, error?: string }}
   */
  static parseContentRange(contentRange, expectedStart = null) {
    if (typeof contentRange !== 'string') {
      return { valid: false, start: 0, end: 0, total: null, error: 'Missing Content-Range header on 206 response' };
    }

    const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim());
    if (!match) {
      return { valid: false, start: 0, end: 0, total: null, error: `Invalid Content-Range format: "${contentRange}"` };
    }

    const start = Number.parseInt(match[1], 10);
    const end = Number.parseInt(match[2], 10);
    const total = match[3] === '*' ? null : Number.parseInt(match[3], 10);

    if (start > end) {
      return { valid: false, start, end, total, error: `Content-Range start (${start}) exceeds end (${end})` };
    }

    if (total !== null && end >= total) {
      return { valid: false, start, end, total, error: `Content-Range end (${end}) exceeds total (${total})` };
    }

    if (expectedStart !== null && start !== expectedStart) {
      return { valid: false, start, end, total, error: `Content-Range start (${start}) does not match requested offset (${expectedStart})` };
    }

    return { valid: true, start, end, total };
  }

  /**
   * Verifies if resource on server has changed compared to previously saved metadata.
   * @param {object} prev
   * @param {string} [prev.etag]
   * @param {string} [prev.lastModified]
   * @param {object} currentHeaders
   * @returns {{ match: boolean, reason?: string }}
   */
  static verifyResourceIdentity(prev, currentHeaders) {
    if (!prev) return { match: true };

    const currentEtag = currentHeaders['etag'] || currentHeaders['ETag'];
    if (prev.etag && currentEtag) {
      // Normalize weak ETag prefix (W/)
      const norm = (e) => e.replace(/^W\//i, '').replace(/^"|"$/g, '').trim();
      if (norm(prev.etag) !== norm(currentEtag)) {
        return { match: false, reason: `ETag changed from ${prev.etag} to ${currentEtag}` };
      }
    }

    const currentLastMod = currentHeaders['last-modified'] || currentHeaders['Last-Modified'];
    if (prev.lastModified && currentLastMod) {
      const prevTime = Date.parse(prev.lastModified);
      const currTime = Date.parse(currentLastMod);
      if (!Number.isNaN(prevTime) && !Number.isNaN(currTime) && currTime > prevTime) {
        return { match: false, reason: `Resource modified date is newer: ${currentLastMod} vs ${prev.lastModified}` };
      }
    }

    return { match: true };
  }

  /**
   * Validates final file integrity.
   * @param {number} actualBytes
   * @param {number|null} expectedTotalBytes
   * @returns {{ valid: boolean, error?: string }}
   */
  static validateCompletion(actualBytes, expectedTotalBytes) {
    if (expectedTotalBytes !== null && expectedTotalBytes !== undefined && expectedTotalBytes >= 0) {
      if (actualBytes !== expectedTotalBytes) {
        return {
          valid: false,
          error: `File size mismatch: downloaded ${actualBytes} bytes, expected ${expectedTotalBytes} bytes.`,
        };
      }
    }

    if (actualBytes <= 0 && expectedTotalBytes !== 0) {
      return {
        valid: false,
        error: 'Completed file is 0 bytes.',
      };
    }

    return { valid: true };
  }
}

module.exports = { DownloadValidator };
