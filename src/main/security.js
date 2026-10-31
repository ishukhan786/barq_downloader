'use strict';

const path = require('node:path');
const brand = require('../shared/brand');

const APP_ORIGIN = `${brand.APP_SCHEME}://${brand.APP_HOST}`;
const ALLOWED_DOWNLOAD_SCHEMES = new Set(['http:', 'https:']);
const MAX_URL_LENGTH = 8192;

/**
 * Validates a user/browser supplied download URL.
 * Only http(s) is accepted; embedded credentials and control characters are rejected.
 * @returns {{ ok: true, url: string } | { ok: false, error: string }}
 */
function validateDownloadUrl(input) {
  if (typeof input !== 'string') return { ok: false, error: 'URL must be text.' };
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Please enter a URL.' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'URL is too long.' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return { ok: false, error: 'URL contains spaces or control characters.' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'This is not a valid URL.' };
  }
  if (!ALLOWED_DOWNLOAD_SCHEMES.has(u.protocol)) {
    return { ok: false, error: `Unsupported scheme "${u.protocol.replace(':', '')}". Only http and https are allowed.` };
  }
  if (!u.hostname) return { ok: false, error: 'URL has no host.' };
  if (u.username || u.password) {
    return { ok: false, error: 'URLs with embedded usernames or passwords are not accepted.' };
  }
  return { ok: true, url: u.toString() };
}

/**
 * True if `candidate` resolves to a location strictly inside `baseDir`
 * (or equal to it when allowEqual). Guards against `..` traversal and
 * absolute-path escapes. Case-insensitive on Windows.
 */
function isPathInside(baseDir, candidate, { allowEqual = false } = {}) {
  if (typeof baseDir !== 'string' || typeof candidate !== 'string') return false;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, candidate);
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(norm(base), norm(target));
  if (rel === '') return allowEqual;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolves `relative` inside `baseDir`, returning null if it would escape.
 */
function safeJoin(baseDir, relative) {
  if (typeof relative !== 'string' || relative.includes('\0')) return null;
  const target = path.resolve(baseDir, relative);
  return isPathInside(baseDir, target) ? target : null;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/**
 * Produces a safe Windows filename from untrusted input (Content-Disposition,
 * URL path, browser message). Strips directory components and illegal chars.
 */
function sanitizeFilename(input, fallback = 'download') {
  let name = typeof input === 'string' ? input : '';
  name = name.replace(/\\/g, '/').split('/').pop() || '';
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[<>:"|?*\u0000-\u001f\u007f]/g, '_');
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  if (name.length > 200) {
    const ext = path.extname(name).slice(0, 20);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name || fallback;
}

/**
 * Validates that an IPC message came from BARQ's own renderer document,
 * served from the privileged barq://app origin, and from the top frame.
 */
function isTrustedSender(event, allowedWebContentsIds) {
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    if (frame.parent) return false; // only top-level frame
    const u = new URL(frame.url);
    if (`${u.protocol}//${u.host}` !== APP_ORIGIN) return false;
    if (allowedWebContentsIds && !allowedWebContentsIds.has(event.sender.id)) return false;
    return true;
  } catch {
    return false;
  }
}

/** Positive integer id from IPC. */
function validateId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

module.exports = {
  APP_ORIGIN,
  validateDownloadUrl,
  isPathInside,
  safeJoin,
  sanitizeFilename,
  isTrustedSender,
  validateId,
};
