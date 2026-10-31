'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeFilename } = require('../security');

/**
 * Resolves safe, collision-free filenames from HTTP headers and URLs.
 */
class FilenameResolver {
  /**
   * Parses Content-Disposition header conforming to RFC 6266 and RFC 5987.
   * e.g., 'attachment; filename="archive.zip"'
   * or    'attachment; filename*=UTF-8\'\'archive%20%281%29.zip'
   * @param {string} disposition
   * @returns {string|null}
   */
  static parseContentDisposition(disposition) {
    if (typeof disposition !== 'string' || !disposition.trim()) return null;

    // 1. Try RFC 5987 encoded filename* (UTF-8''encoded_name)
    const starMatch = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
    if (starMatch && starMatch[1]) {
      let raw = starMatch[1].trim().replace(/^["']|["']$/g, '');
      const parts = raw.split("''");
      if (parts.length === 2) {
        try {
          const decoded = decodeURIComponent(parts[1]);
          if (decoded.trim()) return sanitizeFilename(decoded);
        } catch { /* fallback to standard filename */ }
      }
    }

    // 2. Try standard filename="name" or filename=name
    const stdMatch = /filename\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(disposition);
    if (stdMatch) {
      const name = stdMatch[1] || stdMatch[2];
      if (name && name.trim()) {
        return sanitizeFilename(name);
      }
    }

    return null;
  }

  /**
   * Extracts a filename from a URL path.
   * @param {string} urlString
   * @param {string} [fallback='download']
   * @returns {string}
   */
  static fromUrl(urlString, fallback = 'download') {
    try {
      const u = new URL(urlString);
      const pathname = decodeURIComponent(u.pathname);
      const base = path.basename(pathname);
      return sanitizeFilename(base, fallback);
    } catch {
      return fallback;
    }
  }

  /**
   * Derives candidate filename by priority:
   * 1. Content-Disposition header
   * 2. URL path basename
   * 3. MIME-type-informed default
   * 4. 'download'
   *
   * @param {object} opts
   * @param {string} [opts.contentDisposition]
   * @param {string} opts.url
   * @param {string} [opts.mimeType]
   * @returns {string}
   */
  static resolveCandidate({ contentDisposition, url, mimeType }) {
    if (contentDisposition) {
      const fromDisp = FilenameResolver.parseContentDisposition(contentDisposition);
      if (fromDisp && fromDisp !== 'download') return fromDisp;
    }

    const fromUrl = FilenameResolver.fromUrl(url, '');
    if (fromUrl) {
      // If URL ends with a slash or has no extension and we know MIME type
      if (!path.extname(fromUrl) && mimeType) {
        const ext = FilenameResolver.extensionFromMime(mimeType);
        if (ext) return `${fromUrl}.${ext}`;
      }
      return fromUrl;
    }

    // Default with MIME extension if available
    const ext = FilenameResolver.extensionFromMime(mimeType);
    return ext ? `download.${ext}` : 'download';
  }

  /**
   * Basic MIME to file extension mapping for sensible fallbacks.
   */
  static extensionFromMime(mime) {
    if (!mime || typeof mime !== 'string') return null;
    const clean = mime.split(';')[0].trim().toLowerCase();
    const map = {
      'application/pdf': 'pdf',
      'application/zip': 'zip',
      'application/x-zip-compressed': 'zip',
      'application/x-tar': 'tar',
      'application/gzip': 'gz',
      'application/x-7z-compressed': '7z',
      'application/x-rar-compressed': 'rar',
      'application/json': 'json',
      'application/xml': 'xml',
      'text/plain': 'txt',
      'text/html': 'html',
      'text/csv': 'csv',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/gif': 'gif',
      'image/webp': 'webp',
      'image/svg+xml': 'svg',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/x-matroska': 'mkv',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/wav': 'wav',
      'application/octet-stream': null,
    };
    return map[clean] || null;
  }

  /**
   * Ensures that saving `filename` inside `destinationDir` does not silently overwrite
   * an existing file. If `file.zip` exists, tests `file (1).zip`, `file (2).zip`, etc.
   *
   * @param {string} destinationDir
   * @param {string} filename
   * @param {string} [ignoreFilePath] optional file path that is allowed to exist (e.g. self)
   * @returns {string} The collision-free filename (just the name, not the full path)
   */
  static resolveUniqueFilename(destinationDir, filename, ignoreFilePath = null) {
    const cleanName = sanitizeFilename(filename, 'download');
    let candidate = cleanName;
    const ext = path.extname(cleanName);
    const stem = path.basename(cleanName, ext);

    let counter = 1;
    while (true) {
      const full = path.join(destinationDir, candidate);
      if (ignoreFilePath && path.resolve(full).toLowerCase() === path.resolve(ignoreFilePath).toLowerCase()) {
        return candidate;
      }
      if (!fs.existsSync(full)) {
        return candidate;
      }
      candidate = `${stem} (${counter})${ext}`;
      counter++;
      if (counter > 10000) {
        // Extreme edge case guard
        candidate = `${stem}-${Date.now()}${ext}`;
        break;
      }
    }
    return candidate;
  }
}

module.exports = { FilenameResolver };
