'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|token|access_token|refresh_token|secret|api[_-]?key|x-api-key|bridge[_-]?token)$/i;

/**
 * Redacts credentials from strings: Authorization/Cookie headers, URL userinfo,
 * and sensitive query parameters. Never throws.
 */
function redactString(input) {
  let s = String(input);
  // Header-style "Authorization: Bearer xyz" / "Cookie: a=b"
  s = s.replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, '$1: [REDACTED]');
  // URL userinfo: scheme://user:pass@host
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]*@/gi, '$1[REDACTED]@');
  // Sensitive query params
  s = s.replace(/([?&](?:token|access_token|refresh_token|password|passwd|pwd|secret|api[_-]?key|signature|sig|key)=)[^&#\s]*/gi, '$1[REDACTED]');
  return s;
}

/** Deep-redacts objects (bounded depth) for structured log metadata. */
function redact(value, depth = 0) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (depth > 5) return '[Object]';
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: value.code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function createLogger(logsDir, { echo = true } = {}) {
  const file = logsDir ? path.join(logsDir, 'barq.log') : null;

  function rotateIfNeeded() {
    if (!file) return;
    try {
      const st = fs.statSync(file);
      if (st.size > MAX_LOG_BYTES) {
        fs.rmSync(file + '.1', { force: true });
        fs.renameSync(file, file + '.1');
      }
    } catch { /* file may not exist yet */ }
  }

  function write(level, message, meta) {
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      msg: redactString(message),
      ...(meta !== undefined ? { meta: redact(meta) } : {}),
    });
    if (echo) {
      const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      fn(`[BARQ] ${line}`);
    }
    if (file) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(file, line + '\n');
      } catch { /* logging must never crash the app */ }
    }
  }

  return {
    file,
    info: (m, meta) => write('info', m, meta),
    warn: (m, meta) => write('warn', m, meta),
    error: (m, meta) => write('error', m, meta),
  };
}

module.exports = { createLogger, redact, redactString };
