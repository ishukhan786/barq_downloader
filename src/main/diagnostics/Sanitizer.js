'use strict';

const os = require('node:os');

/**
 * Privacy-first Sanitizer for BARQ Diagnostics & Feedback.
 * Ensures zero personal identifiers, credentials, URLs, UNC paths,
 * IP addresses, local directory paths, or filenames leak into exports.
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
   * Scrubs a string of URLs, IPs, UNC paths, emails, user paths, tokens, cookies, and filenames.
   * @param {string} text
   * @returns {string}
   */
  static scrubText(text) {
    if (typeof text !== 'string') return '';
    let scrubbed = text;

    // 1. Scrub URLs with any protocol (http, https, ftp, ws, wss, file) including ports & query strings
    scrubbed = scrubbed.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>\)]+/gi, '[REDACTED_URL]');

    // 2. Scrub UNC Network Paths (\\server\share\file or //server/share/file, mixed or repeated separators, spaces, parentheses)
    scrubbed = scrubbed.replace(/(?<![:a-zA-Z0-9])(?:\\\\|\/\/)[a-zA-Z0-9_.-]+(?:[\\\/]+[a-zA-Z0-9_.$() -]+)+/g, '[REDACTED_UNC_PATH]');

    // 3. Scrub Windows username from any path or string
    const username = this.getUsername();
    if (username && username.length > 1) {
      const userRegex = new RegExp(`([\\\\/][Uu]sers[\\\\/])${username}([\\\\/]|\\b)`, 'g');
      scrubbed = scrubbed.replace(userRegex, '$1[USER]$2');
      const directRegex = new RegExp(username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      scrubbed = scrubbed.replace(directRegex, '[USER]');
    }

    // 4. Scrub Windows & Unix User Profile Directories
    scrubbed = scrubbed.replace(/[A-Za-z]:\\[Uu]sers\\[^\s"',;&<>]+/g, 'C:\\Users\\[USER]');
    scrubbed = scrubbed.replace(/(?:\/home|\/Users)\/[^\s"',;&<>]+/g, '/home/[USER]');
    scrubbed = scrubbed.replace(/~[a-zA-Z0-9_.-]*/g, '~');

    // 5. Scrub email addresses
    scrubbed = scrubbed.replace(/[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+/g, '[REDACTED_EMAIL]');

    // 6. Scrub Cookies & Authorization Headers (case-insensitive)
    scrubbed = scrubbed.replace(/(?:Authorization|Auth)\s*:\s*(?:Bearer|Basic|Token)\s+[^\s\r\n,;]+/gi, 'Authorization: [REDACTED_TOKEN]');
    scrubbed = scrubbed.replace(/(?:Set-Cookie|Cookie)\s*:\s*[^\r\n,;]+/gi, 'Cookie: [REDACTED_COOKIE]');
    scrubbed = scrubbed.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED_TOKEN]');
    scrubbed = scrubbed.replace(/\bBasic\s+[a-zA-Z0-9+/=]{8,}\b/gi, 'Basic [REDACTED_TOKEN]');

    // 7. Scrub passwords, tokens, API keys, client secrets
    scrubbed = scrubbed.replace(/(password|passwd|pwd|token|apiKey|api_key|secret|client_secret|auth|access_token|refresh_token|cookie)\s*[:=]\s*(?!\[REDACTED)['"]?[^\s"',;&]+['"]?/gi, '$1=[REDACTED_SECRET]');

    // 8. Scrub IPv6 addresses (bracketed with port, mapped, compressed, and full)
    scrubbed = scrubbed.replace(/\[([0-9a-fA-F:]+(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){0,3})\](?::\d{1,5})?/g, (match, ip) => {
      if (ip === '::1' || ip === '::') return match;
      return '[REDACTED_IP]';
    });
    scrubbed = scrubbed.replace(/(?<![a-zA-Z0-9])::ffff:(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\d{1,5})?\b/gi, '[REDACTED_IP]');
    scrubbed = scrubbed.replace(/\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:|\b:(?::[0-9a-fA-F]{1,4}){1,7}\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b/g, (match) => {
      if (match === '::1' || match === '::') return match;
      return '[REDACTED_IP]';
    });

    // 9. Scrub IPv4 addresses (with optional port)
    scrubbed = scrubbed.replace(/\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)(?::\d{1,5})?\b/g, (match) => {
      if (match.startsWith('127.0.0.1') || match.startsWith('0.0.0.0')) return match;
      return '[REDACTED_IP]';
    });

    // 10. Scrub Full Local Windows File Paths across all drive letters and separators
    scrubbed = scrubbed.replace(/[A-Za-z]:[\\\/](?:[^\s"'<>\n\r\\\/]+[\\\/])+[^\s"'<>\n\r]+/g, '[REDACTED_PATH]');

    // 11. Scrub Filenames in logs (quoted, unquoted, with/without ext, Unicode)
    // 11a. Explicit filename fields (no slashes)
    scrubbed = scrubbed.replace(/(?<=\b(?:filename|file_name|file)\s*[:=]\s*)['"]?([^\s"',;&<>\/\\]+)['"]?/gi, '[REDACTED_FILENAME]');
    // 11b. Quoted filenames with common extensions (supports spaces, punctuation, Unicode)
    scrubbed = scrubbed.replace(/"([^"\n\r]+\.(?:exe|zip|iso|mp4|mkv|pdf|tar|gz|bin|dmg|rar|7z|msi|docx?|xlsx?|avi|mov|mp3|flac|wav))"/gi, '"[REDACTED_FILENAME]"');
    // 11c. Standalone or unquoted filenames with common extensions (supports Unicode, non-ASCII)
    scrubbed = scrubbed.replace(/(?:^|(?<=[\s"'`(<[]))([^\s"'`()<>[\]]+\.(?:exe|zip|iso|mp4|mkv|pdf|tar|gz|bin|dmg|rar|7z|msi|docx?|xlsx?|avi|mov|mp3|flac|wav))(?=$|[\s"'`)>\]])/gi, '[REDACTED_FILENAME]');
    // 11d. Quoted filename without extension following file/download keywords
    scrubbed = scrubbed.replace(/(?<=\b(?:file(?:name)?|target|download(?:ed|ing)?|saved?|saving)\s+(?:to\s+)?)["']([^"'\n\r]+)["']/gi, '"[REDACTED_FILENAME]"');

    return scrubbed;
  }

  /**
   * Recursively traverses and sanitizes object properties or array elements.
   * Only allows safe primitive types.
   */
  static scrubObject(obj, depth = 0) {
    if (depth > 6) return '[TRUNCATED_DEPTH]';
    if (obj === null || obj === undefined) return obj;

    if (obj instanceof Error) {
      return {
        name: obj.name,
        message: this.scrubText(obj.message),
        stack: obj.stack ? this.scrubText(obj.stack) : undefined,
      };
    }

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
        // Redact any key that indicates secrets or private user data
        if (/token|secret|password|cookie|auth|credential|key|private/i.test(key)) {
          result[key] = '[REDACTED_SECRET]';
        } else if (/url|source_url/i.test(key)) {
          result[key] = '[REDACTED_URL]';
        } else if (/destination_path|partial_path|path|directory|folder/i.test(key)) {
          result[key] = '[REDACTED_PATH]';
        } else if (/filename|file_name|target_?file|file$/i.test(key)) {
          result[key] = '[REDACTED_FILENAME]';
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
