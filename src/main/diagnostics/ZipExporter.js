'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/**
 * Pure Node.js zero-dependency PKZIP writer and diagnostic bundle packager.
 * Adheres strictly to standard PKZIP 2.0 specifications.
 */
class ZipExporter {
  /**
   * Generates a date-stamped filename for ZIP diagnostics: BARQ-Diagnostics-YYYY-MM-DD-HH-mm.zip
   */
  static generateZipFilename(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = date.getFullYear();
    const m = pad(date.getMonth() + 1);
    const d = pad(date.getDate());
    const h = pad(date.getHours());
    const min = pad(date.getMinutes());
    return `BARQ-Diagnostics-${y}-${m}-${d}-${h}-${min}.zip`;
  }

  /**
   * Generates standard report JSON filename: BARQ-Feedback-BARQ-XXXXXX.json
   */
  static generateJsonFilename(reportId) {
    const safeId = String(reportId || 'report').replace(/[^a-zA-Z0-9_-]/g, '_');
    return `BARQ-Feedback-${safeId}.json`;
  }

  /**
   * Encodes standard DOS timestamp for ZIP headers.
   */
  static dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const seconds = Math.floor(date.getSeconds() / 2);

    const dosTime = (hours << 11) | (minutes << 5) | seconds;
    const dosDate = ((year - 1980) << 9) | (month << 5) | day;
    return { dosTime, dosDate };
  }

  /**
   * Creates a valid, standard PKZIP archive Buffer from an array of files.
   * @param {Array<{ name: string, content: string | Buffer }>} files
   * @returns {Buffer}
   */
  static createZipBuffer(files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('At least one file is required to create a ZIP archive.');
    }

    const { dosTime, dosDate } = this.dosDateTime();
    const localHeaders = [];
    const centralHeaders = [];
    let offset = 0;

    for (const file of files) {
      const filename = String(file.name || 'file.txt').replace(/\\/g, '/');
      const raw = Buffer.isBuffer(file.content)
        ? file.content
        : Buffer.from(typeof file.content === 'string' ? file.content : JSON.stringify(file.content, null, 2), 'utf8');

      const compressed = zlib.deflateRawSync(raw);
      const crc = zlib.crc32(raw);
      const nameBuf = Buffer.from(filename, 'utf8');

      // Local File Header (30 bytes + name length)
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0); // signature
      lh.writeUInt16LE(20, 4);         // version needed: 2.0
      lh.writeUInt16LE(0x0800, 6);     // general purpose flag: bit 11 = UTF-8
      lh.writeUInt16LE(8, 8);          // compression: 8 (deflate)
      lh.writeUInt16LE(dosTime, 10);   // mod time
      lh.writeUInt16LE(dosDate, 12);   // mod date
      lh.writeUInt32LE(crc, 14);       // crc32
      lh.writeUInt32LE(compressed.length, 18); // compressed size
      lh.writeUInt32LE(raw.length, 22);        // uncompressed size
      lh.writeUInt16LE(nameBuf.length, 26);    // filename length
      lh.writeUInt16LE(0, 28);                 // extra field length

      const localRecord = Buffer.concat([lh, nameBuf, compressed]);
      localHeaders.push(localRecord);

      // Central Directory Header (46 bytes + name length)
      const cd = Buffer.alloc(46);
      cd.writeUInt32LE(0x02014b50, 0); // signature
      cd.writeUInt16LE(20, 4);         // version made by
      cd.writeUInt16LE(20, 6);         // version needed: 2.0
      cd.writeUInt16LE(0x0800, 8);     // general purpose flag: UTF-8
      cd.writeUInt16LE(8, 10);         // compression: 8
      cd.writeUInt16LE(dosTime, 12);
      cd.writeUInt16LE(dosDate, 14);
      cd.writeUInt32LE(crc, 16);
      cd.writeUInt32LE(compressed.length, 20);
      cd.writeUInt32LE(raw.length, 24);
      cd.writeUInt16LE(nameBuf.length, 28);
      cd.writeUInt16LE(0, 30);         // extra field length
      cd.writeUInt16LE(0, 32);         // file comment length
      cd.writeUInt16LE(0, 34);         // disk number start
      cd.writeUInt16LE(0, 36);         // internal file attributes
      cd.writeUInt32LE(0x81a40000, 38);// external file attributes (normal file)
      cd.writeUInt32LE(offset, 42);    // relative offset of local header

      centralHeaders.push(Buffer.concat([cd, nameBuf]));
      offset += localRecord.length;
    }

    const centralDir = Buffer.concat(centralHeaders);

    // End of Central Directory Record (22 bytes)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0); // signature
    eocd.writeUInt16LE(0, 4);          // disk number
    eocd.writeUInt16LE(0, 6);          // disk with central dir
    eocd.writeUInt16LE(files.length, 8);   // entries on this disk
    eocd.writeUInt16LE(files.length, 10);  // total entries
    eocd.writeUInt32LE(centralDir.length, 12); // central dir size
    eocd.writeUInt32LE(offset, 16);    // central dir offset
    eocd.writeUInt16LE(0, 20);         // comment length

    return Buffer.concat([...localHeaders, centralDir, eocd]);
  }

  /**
   * Atomically exports full diagnostic ZIP package to target file path.
   */
  static exportZip(destPath, { report, diagnostics, logs, privacyPolicy }) {
    if (!destPath || typeof destPath !== 'string') {
      throw new Error('Destination path is required.');
    }

    const files = [
      {
        name: 'report.json',
        content: JSON.stringify(report || { title: 'Diagnostic Report' }, null, 2),
      },
      {
        name: 'system-diagnostics.json',
        content: JSON.stringify(diagnostics || {}, null, 2),
      },
      {
        name: 'sanitized-events.json',
        content: JSON.stringify(logs || [], null, 2),
      },
      {
        name: 'privacy-manifest.txt',
        content: privacyPolicy || [
          'BARQ DOWNLOADER — DIAGNOSTIC EXPORT PRIVACY MANIFEST',
          '====================================================',
          '',
          'Privacy Principle: Zero Telemetry by Default',
          'BARQ Downloader transmits ZERO automatic data, tracking metrics, or background telemetry.',
          'All diagnostic collections are strictly initiated by the user.',
          '',
          'Verification of Included Data:',
          ' - OS platform, architecture, CPU count, and RAM summary',
          ' - Electron, Node.js, and SQLite schema runtime version numbers',
          ' - Aggregate download counters (queued, completed, failed counts)',
          ' - Scrubbed event logs with URLs, paths, tokens, and credentials redacted',
          '',
          'Exclusions Guarantee:',
          ' - NO passwords, credentials, or cookies',
          ' - NO download URLs or complete destination file paths',
          ' - NO database files (.db) or partial download chunks (.barq-part)',
          ' - NO personal user folder names or system accounts',
          '',
          `Generated: ${new Date().toISOString()}`,
        ].join('\n'),
      },
    ];

    const zipBuffer = this.createZipBuffer(files);

    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${destPath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, zipBuffer);
    fs.renameSync(tempPath, destPath);

    return {
      path: destPath,
      bytes: zipBuffer.length,
      filesCount: files.length,
    };
  }

  /**
   * Atomically exports single JSON report to target file path.
   */
  static exportJson(destPath, data) {
    if (!destPath || typeof destPath !== 'string') {
      throw new Error('Destination path is required.');
    }

    const payload = JSON.stringify(data, null, 2);
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const tempPath = `${destPath}.tmp-${Date.now()}`;
    fs.writeFileSync(tempPath, payload, 'utf8');
    fs.renameSync(tempPath, destPath);

    return {
      path: destPath,
      bytes: Buffer.byteLength(payload, 'utf8'),
    };
  }
}

module.exports = { ZipExporter };
