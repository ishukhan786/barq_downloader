'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');
const { FilenameResolver } = require('./FilenameResolver');
const { DownloadValidator } = require('./DownloadValidator');

const USER_AGENT = 'BARQ Downloader/0.1.0 (Windows NT 10.0; Win64; x64)';
const DEFAULT_CONNECT_TIMEOUT = 15000;
const DEFAULT_SOCKET_TIMEOUT = 30000;
const MAX_REDIRECTS = 5;

/**
 * Low-level HTTP/HTTPS streaming client for BARQ Downloader.
 */
class HttpClient {
  /**
   * Probes URL metadata (HEAD request with fallback to range GET)
   * to discover filename, size, range support, and MIME type without downloading payload.
   *
   * @param {string} targetUrl
   * @param {object} [opts]
   * @param {number} [opts.timeout=DEFAULT_CONNECT_TIMEOUT]
   * @param {Record<string,string>} [opts.headers={}]
   * @returns {Promise<object>}
   */
  static async probe(targetUrl, { timeout = DEFAULT_CONNECT_TIMEOUT, headers = {} } = {}) {
    try {
      const headRes = await HttpClient._request(targetUrl, {
        method: 'HEAD',
        timeout,
        headers,
      });

      // If HEAD is not allowed (405) or not implemented (501), try a GET with Range: bytes=0-0
      if (headRes.statusCode === 405 || headRes.statusCode === 501) {
        headRes.response.resume(); // discard body
        return await HttpClient._probeWithGet(headRes.finalUrl || targetUrl, { timeout, headers });
      }

      headRes.response.resume();
      return HttpClient._parseProbeResponse(headRes);
    } catch (headErr) {
      // Fallback: some servers close connection on HEAD, attempt probe with GET
      try {
        return await HttpClient._probeWithGet(targetUrl, { timeout, headers });
      } catch {
        throw headErr;
      }
    }
  }

  /**
   * Fallback probe using GET with Range 0-0.
   */
  static async _probeWithGet(targetUrl, { timeout, headers }) {
    const getRes = await HttpClient._request(targetUrl, {
      method: 'GET',
      timeout,
      headers: { ...headers, Range: 'bytes=0-0' },
    });

    // Abort stream immediately once headers are read
    const parsed = HttpClient._parseProbeResponse(getRes);
    getRes.response.destroy();
    return parsed;
  }

  static _parseProbeResponse(res) {
    const headers = res.headers;
    const statusCode = res.statusCode;
    const finalUrl = res.finalUrl;

    const acceptRanges = headers['accept-ranges'] || '';
    const contentRange = headers['content-range'] || '';
    const contentLength = headers['content-length'] ? Number.parseInt(headers['content-length'], 10) : null;
    const mimeType = headers['content-type'] ? headers['content-type'].split(';')[0].trim().toLowerCase() : null;
    const etag = headers['etag'] || null;
    const lastModified = headers['last-modified'] || null;
    const disposition = headers['content-disposition'] || null;

    let totalBytes = null;
    let supportsRanges = false;

    if (statusCode === 206 && contentRange) {
      supportsRanges = true;
      const parsedCr = DownloadValidator.parseContentRange(contentRange);
      if (parsedCr.valid && parsedCr.total !== null) {
        totalBytes = parsedCr.total;
      }
    } else if (statusCode === 200) {
      if (acceptRanges.toLowerCase().includes('bytes')) {
        supportsRanges = true;
      }
      if (contentLength !== null && !Number.isNaN(contentLength)) {
        totalBytes = contentLength;
      }
    }

    const filename = FilenameResolver.resolveCandidate({
      contentDisposition: disposition,
      url: finalUrl,
      mimeType,
    });

    return {
      ok: true,
      statusCode,
      url: targetUrlFromRes(res),
      finalUrl,
      filename,
      mimeType,
      totalBytes,
      supportsRanges,
      etag,
      lastModified,
      headers,
    };
  }

  /**
   * Initiates a streaming GET request.
   *
   * @param {string} targetUrl
   * @param {object} [opts]
   * @param {number} [opts.rangeStart] byte offset for resuming
   * @param {string} [opts.ifRange] ETag or Last-Modified for conditional range
   * @param {Record<string,string>} [opts.headers={}]
   * @param {number} [opts.timeout=DEFAULT_SOCKET_TIMEOUT]
   * @returns {Promise<{ response: http.IncomingMessage, finalUrl: string, statusCode: number, headers: object, abort: Function }>}
   */
  static async getStream(targetUrl, { rangeStart = null, ifRange = null, headers = {}, timeout = DEFAULT_SOCKET_TIMEOUT } = {}) {
    const requestHeaders = { ...headers };

    if (rangeStart !== null && rangeStart > 0) {
      requestHeaders['Range'] = `bytes=${rangeStart}-`;
      if (ifRange) {
        requestHeaders['If-Range'] = ifRange;
      }
    }

    return HttpClient._request(targetUrl, {
      method: 'GET',
      headers: requestHeaders,
      timeout,
    });
  }

  /**
   * Internal request executor following redirects up to MAX_REDIRECTS.
   */
  static _request(urlString, { method, headers = {}, timeout, redirectCount = 0 }) {
    return new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(urlString);
      } catch (err) {
        return reject(new Error(`Invalid URL: ${urlString}`));
      }

      const isHttps = url.protocol === 'https:';
      const client = isHttps ? https : http;

      const reqHeaders = {
        'User-Agent': USER_AGENT,
        'Accept': '*/*',
        'Connection': 'keep-alive',
        ...headers,
      };

      const reqOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: reqHeaders,
      };

      let aborted = false;
      let timer = null;

      const req = client.request(reqOptions, (res) => {
        if (timer) clearTimeout(timer);

        const statusCode = res.statusCode || 200;

        // Check for redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          res.resume(); // consume response body to release memory

          if (redirectCount >= MAX_REDIRECTS) {
            return reject(new Error(`Too many redirects (limit: ${MAX_REDIRECTS})`));
          }

          const redirectUrl = new URL(res.headers.location, url).toString();

          // Check security: validate protocol and prevent downgrade from HTTPS to HTTP on redirect
          const nextUrl = new URL(redirectUrl);
          if (nextUrl.protocol !== 'http:' && nextUrl.protocol !== 'https:') {
            return reject(new Error(`Untrusted redirect protocol: ${nextUrl.protocol}`));
          }
          if (url.protocol === 'https:' && nextUrl.protocol === 'http:') {
            return reject(new Error('Insecure redirect from HTTPS to HTTP rejected.'));
          }

          // Follow redirect recursively
          return resolve(
            HttpClient._request(redirectUrl, {
              method: (statusCode === 303 && method !== 'HEAD') ? 'GET' : method,
              headers,
              timeout,
              redirectCount: redirectCount + 1,
            })
          );
        }

        resolve({
          response: res,
          finalUrl: url.toString(),
          statusCode,
          headers: res.headers,
          abort: () => {
            aborted = true;
            req.destroy();
            res.destroy();
          },
        });
      });

      const abortFn = () => {
        aborted = true;
        req.destroy(new Error('Request aborted by caller'));
      };

      // Set timeout
      if (timeout > 0) {
        timer = setTimeout(() => {
          if (!aborted) {
            req.destroy(new Error(`Connection timed out after ${timeout}ms`));
          }
        }, timeout);
      }

      req.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(err);
      });

      req.end();
    });
  }
}

function targetUrlFromRes(res) {
  return res.finalUrl || '';
}

module.exports = { HttpClient, USER_AGENT };
