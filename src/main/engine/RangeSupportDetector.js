'use strict';

const { HttpClient } = require('./HttpClient');
const { DownloadValidator } = require('./DownloadValidator');

/**
 * Actively verifies HTTP Range support and evaluates whether a remote resource
 * is eligible for multi-segment parallel downloading.
 */
class RangeSupportDetector {
  /**
   * Performs an active probe using `Range: bytes=0-0` to verify real byte-level range support.
   *
   * @param {string} url remote resource URL
   * @param {object} [options]
   * @param {number} [options.timeout=10000] probe timeout in ms
   * @param {number} [options.minSegmentSize=1048576] minimum size to warrant segmentation (default 1 MB)
   * @param {boolean} [options.autoSegmentation=true] user configuration preference
   * @returns {Promise<{
   *   supportsRanges: boolean,
   *   statusCode: number,
   *   totalBytes: number|null,
   *   etag: string|null,
   *   lastModified: string|null,
   *   mimeType: string|null,
   *   finalUrl: string,
   *   isEligible: boolean,
   *   reason: string
   * }>}
   */
  static async detect(url, { timeout = 10000, minSegmentSize = 1048576, autoSegmentation = true } = {}) {
    if (!autoSegmentation) {
      return {
        supportsRanges: false,
        statusCode: 0,
        totalBytes: null,
        etag: null,
        lastModified: null,
        mimeType: null,
        finalUrl: url,
        isEligible: false,
        reason: 'Segmentation disabled by user settings.',
      };
    }

    let probeRes;
    try {
      probeRes = await HttpClient._request(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        timeout,
      });
    } catch (err) {
      return {
        supportsRanges: false,
        statusCode: 0,
        totalBytes: null,
        etag: null,
        lastModified: null,
        mimeType: null,
        finalUrl: url,
        isEligible: false,
        reason: `Range probe network error: ${err.message}`,
      };
    }

    const { statusCode, headers, finalUrl, response } = probeRes;

    // Destroy stream immediately after reading headers to avoid downloading content
    try {
      response.destroy();
    } catch {}

    const etag = headers['etag'] || null;
    const lastModified = headers['last-modified'] || null;
    const mimeType = headers['content-type'] ? headers['content-type'].split(';')[0].trim().toLowerCase() : null;

    // 1. If server returned 200 OK, it ignored the Range header
    if (statusCode === 200) {
      const cl = headers['content-length'] ? Number.parseInt(headers['content-length'], 10) : null;
      return {
        supportsRanges: false,
        statusCode: 200,
        totalBytes: Number.isSafeInteger(cl) ? cl : null,
        etag,
        lastModified,
        mimeType,
        finalUrl,
        isEligible: false,
        reason: 'Server ignored Range header and returned full content (HTTP 200). Range requests not supported.',
      };
    }

    // 2. If server did not return 206 Partial Content, Range is unsupported or rejected
    if (statusCode !== 206) {
      return {
        supportsRanges: false,
        statusCode,
        totalBytes: null,
        etag,
        lastModified,
        mimeType,
        finalUrl,
        isEligible: false,
        reason: `Server responded with HTTP ${statusCode} to Range request (expected 206).`,
      };
    }

    // 3. Inspect and validate Content-Range header
    const contentRange = headers['content-range'] || headers['Content-Range'] || '';
    if (!contentRange) {
      return {
        supportsRanges: false,
        statusCode: 206,
        totalBytes: null,
        etag,
        lastModified,
        mimeType,
        finalUrl,
        isEligible: false,
        reason: 'Server returned HTTP 206 without Content-Range header.',
      };
    }

    const crParsed = DownloadValidator.parseContentRange(contentRange, 0);
    if (!crParsed.valid || crParsed.total === null) {
      return {
        supportsRanges: false,
        statusCode: 206,
        totalBytes: null,
        etag,
        lastModified,
        mimeType,
        finalUrl,
        isEligible: false,
        reason: `Invalid Content-Range returned (${contentRange}): ${crParsed.error || 'Total size unknown'}`,
      };
    }

    const totalBytes = crParsed.total;

    // 4. Check file size threshold (avoid segmenting small files where overhead exceeds gain)
    if (totalBytes < minSegmentSize) {
      return {
        supportsRanges: true,
        statusCode: 206,
        totalBytes,
        etag,
        lastModified,
        mimeType,
        finalUrl,
        isEligible: false,
        reason: `File size (${totalBytes} bytes) is below minimum segmentation threshold (${minSegmentSize} bytes).`,
      };
    }

    return {
      supportsRanges: true,
      statusCode: 206,
      totalBytes,
      etag,
      lastModified,
      mimeType,
      finalUrl,
      isEligible: true,
      reason: 'Server verified for multi-segment acceleration (valid HTTP 206 Range response).',
    };
  }
}

module.exports = { RangeSupportDetector };
