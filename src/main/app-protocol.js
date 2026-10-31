'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');
const brand = require('../shared/brand');
const { safeJoin } = require('./security');

const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * Strict CSP sent as a response header for every renderer document
 * (also duplicated as a <meta> tag in each HTML file as defence in depth).
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Must be called before app 'ready'. */
function registerPrivilegedScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: brand.APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: false },
    },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/**
 * Serves files from src/renderer only. Any path that would escape the
 * renderer root (../, encoded traversal, absolute paths) returns 404.
 */
function registerAppProtocol(ses, logger) {
  ses.protocol.handle(brand.APP_SCHEME, async (request) => {
    let url;
    try { url = new URL(request.url); } catch { return notFound(); }
    if (url.host !== brand.APP_HOST || request.method !== 'GET') return notFound();
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return notFound(); }
    rel = rel.replace(/^\/+/, '') || 'index.html';
    const file = safeJoin(RENDERER_ROOT, rel);
    if (!file) {
      logger.warn('Blocked renderer path traversal attempt', { path: url.pathname });
      return notFound();
    }
    const type = MIME[path.extname(file).toLowerCase()];
    if (!type) return notFound();
    try {
      const body = await fs.promises.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': type,
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return notFound();
    }
  });
}

module.exports = { registerPrivilegedScheme, registerAppProtocol, CSP, RENDERER_ROOT };
