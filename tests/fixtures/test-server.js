'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

/**
 * Creates a deterministic test buffer of given size using a seed byte.
 */
function createDeterministicBuffer(size, seed = 0x42) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) {
    buf[i] = (seed + i) % 256;
  }
  return buf;
}

/**
 * Calculates SHA-256 hash of a buffer or string.
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Creates a controlled HTTP test server for download engine tests.
 */
function createTestServer() {
  const smallBuffer = createDeterministicBuffer(64 * 1024, 0x11); // 64 KB
  const largeBuffer = createDeterministicBuffer(2 * 1024 * 1024, 0x77); // 2 MB
  const buf1mb = createDeterministicBuffer(1024 * 1024, 0x33); // 1 MB
  const buf10mb = createDeterministicBuffer(10 * 1024 * 1024, 0x55); // 10 MB
  const buf100mb = createDeterministicBuffer(100 * 1024 * 1024, 0x88); // 100 MB

  const smallHash = sha256(smallBuffer);
  const largeHash = sha256(largeBuffer);
  const hash1mb = sha256(buf1mb);
  const hash10mb = sha256(buf10mb);
  const hash100mb = sha256(buf100mb);

  let retryAttempts = 0;
  let dynamicEtagCount = 0;

  function serveBuffer(req, res, buffer, hash, defaultFilename = 'data.bin') {
    const range = req.headers['range'];
    if (range) {
      const match = /^bytes=(\d+)-(\d+)?$/i.exec(range);
      if (match) {
        const start = Number.parseInt(match[1], 10);
        const end = match[2] ? Number.parseInt(match[2], 10) : buffer.length - 1;

        if (start >= buffer.length || start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${buffer.length}` });
          return res.end();
        }

        const slice = buffer.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
          'Accept-Ranges': 'bytes',
          'ETag': `"${hash}"`,
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(slice);
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': buffer.length,
      'Accept-Ranges': 'bytes',
      'ETag': `"${hash}"`,
    });
    if (req.method === 'HEAD') return res.end();
    return res.end(buffer);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // 1. Small file
    if (pathname === '/small') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
        'Accept-Ranges': 'bytes',
        'ETag': `"${smallHash}"`,
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(smallBuffer);
    }

    // 1b. Dedicated file size endpoints (1 MB, 10 MB, 100 MB)
    if (pathname === '/1mb') {
      return serveBuffer(req, res, buf1mb, hash1mb, '1mb.bin');
    }
    if (pathname === '/10mb') {
      return serveBuffer(req, res, buf10mb, hash10mb, '10mb.bin');
    }
    if (pathname === '/100mb') {
      return serveBuffer(req, res, buf100mb, hash100mb, '100mb.bin');
    }

    // 2. Large file with full Range support
    if (pathname === '/large' || pathname === '/range-supported') {
      const buffer = pathname === '/large' ? largeBuffer : smallBuffer;
      const hash = pathname === '/large' ? largeHash : smallHash;
      const range = req.headers['range'];

      if (range) {
        const match = /^bytes=(\d+)-(\d+)?$/i.exec(range);
        if (match) {
          const start = Number.parseInt(match[1], 10);
          const end = match[2] ? Number.parseInt(match[2], 10) : buffer.length - 1;

          if (start >= buffer.length || start > end) {
            res.writeHead(416, {
              'Content-Range': `bytes */${buffer.length}`,
            });
            return res.end();
          }

          const slice = buffer.subarray(start, end + 1);
          res.writeHead(206, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': slice.length,
            'Content-Range': `bytes ${start}-${end}/${buffer.length}`,
            'Accept-Ranges': 'bytes',
            'ETag': `"${hash}"`,
          });
          if (req.method === 'HEAD') return res.end();
          return res.end(slice);
        }
      }

      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': buffer.length,
        'Accept-Ranges': 'bytes',
        'ETag': `"${hash}"`,
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(buffer);
    }

    // 3. Unknown Content-Length (Chunked transfer encoding)
    if (pathname === '/unknown-length') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        // Note: No Content-Length header
      });
      if (req.method === 'HEAD') return res.end();

      // Send in multiple chunked writes
      res.write(smallBuffer.subarray(0, 16384));
      setTimeout(() => {
        res.write(smallBuffer.subarray(16384, 32768));
        res.write(smallBuffer.subarray(32768));
        res.end();
      }, 50);
      return;
    }

    // 4. Content-Disposition filename
    if (pathname === '/disposition') {
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Length': smallBuffer.length,
        'Content-Disposition': 'attachment; filename="annual_report_2026.pdf"',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(smallBuffer);
    }

    // 5. Content-Disposition RFC 5987 / UTF-8
    if (pathname === '/disposition-rfc5987') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
        'Content-Disposition': "attachment; filename*=UTF-8''barq%20data%20%281%29.bin",
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(smallBuffer);
    }

    // 5b. Content-Disposition Special & Unicode
    if (pathname === '/disposition-special') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
        'Content-Disposition': 'attachment; filename="barq:test*file?v1<2>.zip"',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(smallBuffer);
    }
    if (pathname === '/disposition-urdu') {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
        'Content-Disposition': "attachment; filename*=UTF-8''barq%20%D8%A8%D8%B1%D9%82.zip",
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(smallBuffer);
    }

    // 6. Redirect chains
    if (pathname === '/redirect-1') {
      res.writeHead(302, { 'Location': '/redirect-2' });
      return res.end();
    }
    if (pathname === '/redirect-2') {
      res.writeHead(307, { 'Location': '/small' });
      return res.end();
    }
    if (pathname === '/redirect-chain-1') {
      res.writeHead(301, { 'Location': '/redirect-chain-2' });
      return res.end();
    }
    if (pathname === '/redirect-chain-2') {
      res.writeHead(308, { 'Location': '/redirect-chain-3' });
      return res.end();
    }
    if (pathname === '/redirect-chain-3') {
      res.writeHead(302, { 'Location': '/redirect-chain-4' });
      return res.end();
    }
    if (pathname === '/redirect-chain-4') {
      res.writeHead(307, { 'Location': '/1mb' });
      return res.end();
    }
    if (pathname === '/bad-redirect') {
      res.writeHead(302, { 'Location': 'file:///C:/boot.ini' });
      return res.end();
    }

    // 7. Error endpoints
    if (pathname === '/404') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('File Not Found');
    }
    if (pathname === '/403') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Forbidden');
    }
    if (pathname === '/500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Server Error');
    }
    if (pathname === '/503') {
      res.writeHead(503, { 'Content-Type': 'text/plain' });
      return res.end('Service Unavailable');
    }
    if (pathname === '/416') {
      res.writeHead(416, { 'Content-Range': `bytes */${smallBuffer.length}` });
      return res.end();
    }

    // 8. Rate limit / 429 with Retry-After (succeeds on attempt 3)
    if (pathname === '/429-retry') {
      retryAttempts++;
      if (retryAttempts < 3) {
        res.writeHead(429, {
          'Retry-After': '1',
          'Content-Type': 'text/plain',
        });
        return res.end('Too Many Requests');
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
      });
      return res.end(smallBuffer);
    }

    // 9. Drop midway connection
    if (pathname === '/drop-midway') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': smallBuffer.length,
          'Accept-Ranges': 'bytes',
        });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
        'Accept-Ranges': 'bytes',
      });
      res.write(smallBuffer.subarray(0, 16384));
      setTimeout(() => {
        req.socket.destroy();
      }, 50);
      return;
    }

    // 10. Server ignores Range header and returns 200 with full content
    if (pathname === '/range-ignored') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': smallBuffer.length,
        });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': smallBuffer.length,
      });
      return res.end(smallBuffer);
    }

    // 11. Invalid Content-Range header
    if (pathname === '/invalid-range') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': 100,
          'Accept-Ranges': 'bytes',
        });
        return res.end();
      }
      res.writeHead(206, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': 100,
        'Content-Range': 'bytes invalid-range-spec',
      });
      return res.end(smallBuffer.subarray(0, 100));
    }

    // 12. Dynamic ETag (Resource changes)
    if (pathname === '/dynamic-etag') {
      dynamicEtagCount++;
      const currentEtag = `etag-v${dynamicEtagCount}`;
      const payload = Buffer.from(`Resource Version ${dynamicEtagCount}`);
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Length': payload.length,
        'ETag': currentEtag,
      });
      return res.end(payload);
    }

    // 13. Slow streaming file (for pause/cancel testing)
    if (pathname === '/slow-stream') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': largeBuffer.length,
          'Accept-Ranges': 'bytes',
          'ETag': `"${largeHash}"`,
          'Content-Disposition': 'attachment; filename="slow-stream.bin"',
        });
        return res.end();
      }

      let start = 0;
      let end = largeBuffer.length - 1;
      const range = req.headers['range'];
      const isRange = !!range;

      if (range) {
        const match = /^bytes=(\d+)-(\d+)?$/i.exec(range);
        if (match) {
          start = Number.parseInt(match[1], 10);
          if (match[2]) end = Number.parseInt(match[2], 10);
        }
      }

      if (isRange) {
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${largeBuffer.length}`,
          'Accept-Ranges': 'bytes',
          'ETag': `"${largeHash}"`,
          'Content-Disposition': 'attachment; filename="slow-stream.bin"',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': largeBuffer.length,
          'Accept-Ranges': 'bytes',
          'ETag': `"${largeHash}"`,
          'Content-Disposition': 'attachment; filename="slow-stream.bin"',
        });
      }

      let offset = start;
      const chunkSize = 64 * 1024;
      const interval = setInterval(() => {
        if (offset > end) {
          clearInterval(interval);
          return res.end();
        }
        const next = Math.min(offset + chunkSize, end + 1);
        const slice = largeBuffer.subarray(offset, next);
        offset = next;
        res.write(slice);
      }, 20);

      req.on('close', () => {
        clearInterval(interval);
      });
      return;
    }

    // 13b. Dedicated UI test stream (10 MB streamed at 32 KB / 40ms, total ~12 seconds)
    if (pathname === '/ui-stream') {
      if (req.method === 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf10mb.length,
          'Accept-Ranges': 'bytes',
          'ETag': `"${hash10mb}"`,
          'Content-Disposition': 'attachment; filename="ui-stream.bin"',
        });
        return res.end();
      }

      let start = 0;
      let end = buf10mb.length - 1;
      const range = req.headers['range'];
      const isRange = !!range;

      if (range) {
        const match = /^bytes=(\d+)-(\d+)?$/i.exec(range);
        if (match) {
          start = Number.parseInt(match[1], 10);
          if (match[2]) end = Number.parseInt(match[2], 10);
        }
      }

      if (isRange) {
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${buf10mb.length}`,
          'Accept-Ranges': 'bytes',
          'ETag': `"${hash10mb}"`,
          'Content-Disposition': 'attachment; filename="ui-stream.bin"',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': buf10mb.length,
          'Accept-Ranges': 'bytes',
          'ETag': `"${hash10mb}"`,
          'Content-Disposition': 'attachment; filename="ui-stream.bin"',
        });
      }

      let offset = start;
      const chunkSize = 32 * 1024;
      const interval = setInterval(() => {
        if (offset > end) {
          clearInterval(interval);
          return res.end();
        }
        const next = Math.min(offset + chunkSize, end + 1);
        const slice = buf10mb.subarray(offset, next);
        offset = next;
        res.write(slice);
      }, 40);

      req.on('close', () => {
        clearInterval(interval);
      });
      return;
    }

    // Default
    res.writeHead(404);
    res.end();
  });

  return {
    server,
    smallBuffer,
    largeBuffer,
    buf1mb,
    buf10mb,
    buf100mb,
    smallHash,
    largeHash,
    hash1mb,
    hash10mb,
    hash100mb,
    resetRetries: () => { retryAttempts = 0; },
    start: () => new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    }),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { createTestServer, sha256 };
