'use strict';

const os = require('node:os');

/**
 * Privacy-first Sanitizer for BARQ Diagnostics & Feedback.
 * Ensures zero personal identifiers, credentials, URLs, or local user paths leak into exports.
 */
class Sanitizer {
  static getUsername() {
    try {
      return os.userInfo().username || process.env.USERNAME || process.env.USER || '';
    } catch {
      return process.env.USERNAME || process.env.USER || '';
    }
  }

  /**
   * Scrubs a string of URLs, emails, Windows/Unix user paths, tokens, and IP addresses.
   * @param {string} text
   * @returns {string}
   */
  static scrubText(text) {
    if (typeof text !== 'string') return '';
    let scrubbed = text;

    // 1. Scrub Windows username from any path
    const username = this.getUsername();
    if (username && username.length > 1) {
      const userRegex = new RegExp(`([\\\\/][Uu]sers[\\\\/])${username}([\\\\/]|\\b)`, 'g');
      scrubbed = scrubbed.replace(userRegex, '$1[USER]$2');
      // Direct username occurrences in file paths
      const directRegex = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      scrubbed = scrubbed.replace(directRegex, '[USER]');
    }

    // 2. Scrub Windows full user paths: C:\Users\...\
    scrubbed = scrubbed.replace(/[A-Za-z]:\\[Uu]sers\\[^\\]+/g, 'C:\\Users\\[USER]');

    // 3. Scrub HTTP/HTTPS URLs with query params, paths, or credentials
    scrubbed = scrubbed.replace(/https?:\/\/[^\s"'<>\)]+/gi, '[REDACTED_URL]');

    // 4. Scrub email addresses
    scrubbed = scrubbed.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]');

    // 5. Scrub auth tokens & bearer strings
    scrubbed = scrubbed.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED_TOKEN]');
    scrubbed = scrubbed.replace(/(token|secret|password|passwd|apiKey|auth)\s*[:=]\s*['"]?[^\s"',;&]+['"]?/gi, '$1=[REDACTED_SECRET]');

    // 6. Scrub IPv4 addresses (excluding 127.0.0.1 and 0.0.0.0)
    scrubbed = scrubbed.replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b/g, (match) => {
      if (match === '127.0.0.1' || match === '0.0.0.0') return match;
      return '[REDACTED_IP]';
    });

    return scrubbed;
  }

  /**
   * Recursively traverses and sanitizes object properties or array elements.
   * Only allows safe primitive types.
   */
  static scrubObject(obj, depth = 0) {
    if (depth > 6) return '[TRUNCATED_DEPTH]';
    if (obj === null || obj === undefined) return obj;

    if (typeof obj === 'string') {
      return this.scrubText(obj);
    }

    if (typeof obj === 'number' || typeof obj === 'boolean') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.scrubObject(item, depth + 1));
    }

    if (typeof obj === 'object') {
      const result = {};
      for (const [key, val] of Object.entries(obj)) {
        // Redact any key that suggests secrets
        if (/token|secret|password|cookie|auth|credential/i.test(key)) {
          result[key] = '[REDACTED_SECRET]';
        } else {
          result[key] = this.scrubObject(val, depth + 1);
        }
      }
      return result;
    }

    return String(obj);
  }
}

module.exports = { Sanitizer };
