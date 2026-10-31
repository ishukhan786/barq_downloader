'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

/**
 * Merges completed segment files sequentially in exact byte order,
 * validates final output size and cryptographic integrity, and atomically finalizes the download.
 */
class SegmentMerger {
  /**
   * Merges all segments for a completed segmented download.
   *
   * @param {object} params
   * @param {Array<object>} params.segments array of segment records from database
   * @param {string} params.destinationPath destination directory
   * @param {string} params.filename final destination filename
   * @param {number} params.totalBytes expected total file size
   * @param {string} [params.expectedHash] optional expected SHA-256 hex string
   * @param {object} [params.logger] logger
   * @returns {Promise<{ finalPath: string, finalSize: number, sha256?: string }>}
   */
  static async merge({
    segments,
    destinationPath,
    filename,
    totalBytes,
    expectedHash = null,
    logger = null,
  }) {
    const log = logger || { info() {}, warn() {}, error() {} };

    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('Cannot merge: segment list is empty.');
    }
    if (!destinationPath || !filename) {
      throw new Error('Destination path and filename are required for segment merge.');
    }

    // 1. Sort strictly by segment_index ASC
    const sorted = [...segments].sort((a, b) => a.segment_index - b.segment_index);

    // 2. Pre-merge validation: confirm every segment is complete and intact on disk
    let verifiedSum = 0;
    for (let i = 0; i < sorted.length; i++) {
      const seg = sorted[i];
      if (seg.segment_index !== i) {
        throw new Error(`Segment ordering gap: expected index ${i}, found ${seg.segment_index}`);
      }

      if (seg.status !== 'completed') {
        throw new Error(`Cannot merge: segment #${i} has status '${seg.status}' (expected 'completed')`);
      }

      if (!fs.existsSync(seg.temporary_path)) {
        throw new Error(`Cannot merge: temporary part file missing on disk: ${seg.temporary_path}`);
      }

      const stat = fs.statSync(seg.temporary_path);
      const expectedSegBytes = seg.end_byte - seg.start_byte + 1;

      if (stat.size !== expectedSegBytes) {
        throw new Error(
          `Cannot merge: segment #${i} disk size mismatch (expected ${expectedSegBytes} bytes, found ${stat.size} bytes)`
        );
      }

      if (i > 0) {
        const prev = sorted[i - 1];
        if (seg.start_byte !== prev.end_byte + 1) {
          throw new Error(
            `Cannot merge: byte discontinuity between segment #${i - 1} (ends ${prev.end_byte}) and segment #${i} (starts ${seg.start_byte})`
          );
        }
      }

      verifiedSum += stat.size;
    }

    if (verifiedSum !== totalBytes) {
      throw new Error(`Cannot merge: sum of segment sizes (${verifiedSum}) does not equal expected total (${totalBytes})`);
    }

    const finalPath = path.join(path.resolve(destinationPath), filename);
    const mergeTempPath = path.join(path.resolve(destinationPath), `${filename}.barq-merge`);

    log.info(`Starting sequential merge of ${sorted.length} segments into ${mergeTempPath}...`);

    // Ensure destination directory exists
    fs.mkdirSync(path.dirname(mergeTempPath), { recursive: true });

    // 3. Sequential streaming with backpressure and comprehensive error handling
    const outStream = fs.createWriteStream(mergeTempPath, { flags: 'w', highWaterMark: 128 * 1024 });
    let outError = null;
    const onOutStreamError = (err) => { outError = err; };
    outStream.on('error', onOutStreamError);

    try {
      for (const seg of sorted) {
        if (outError) throw outError;
        const inStream = fs.createReadStream(seg.temporary_path, { highWaterMark: 128 * 1024 });
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            inStream.removeListener('error', onInError);
            inStream.removeListener('end', onInEnd);
            outStream.removeListener('error', onPipeOutError);
          };
          const onInError = (err) => { cleanup(); inStream.unpipe(outStream); reject(err); };
          const onPipeOutError = (err) => { cleanup(); inStream.unpipe(outStream); reject(err); };
          const onInEnd = () => { cleanup(); resolve(); };
          inStream.once('error', onInError);
          outStream.once('error', onPipeOutError);
          inStream.once('end', onInEnd);
          inStream.pipe(outStream, { end: false });
        });
      }

      if (outError) throw outError;
      await new Promise((resolve, reject) => {
        outStream.end((err) => (err ? reject(err) : resolve()));
      });

      // 4. Verify merged file size on disk
      const mergedStat = fs.statSync(mergeTempPath);
      if (mergedStat.size !== totalBytes) {
        throw new Error(
          `Merged output size mismatch: expected ${totalBytes} bytes, wrote ${mergedStat.size} bytes.`
        );
      }

      // 5. Verify cryptographic hash if provided
      let calculatedHash = null;
      if (expectedHash) {
        log.info('Verifying SHA-256 hash of merged file...');
        calculatedHash = await SegmentMerger._computeFileSha256(mergeTempPath);
        if (calculatedHash.toLowerCase() !== expectedHash.toLowerCase()) {
          throw new Error(
            `SHA-256 integrity mismatch after merge! Expected: ${expectedHash}, Calculated: ${calculatedHash}`
          );
        }
      }

      // 6. Atomic move to final path
      if (fs.existsSync(finalPath)) {
        try { fs.unlinkSync(finalPath); } catch {}
      }
      fs.renameSync(mergeTempPath, finalPath);

      log.info(`Merged file finalized successfully at ${finalPath} (${mergedStat.size} bytes).`);

      // 7. Cleanup segment temporary files only after verified finalization
      SegmentMerger._cleanupParts(sorted, log);

      return {
        finalPath,
        finalSize: mergedStat.size,
        sha256: calculatedHash,
      };
    } catch (mergeErr) {
      // On failure: discard incomplete merge temp file, but PRESERVE all .part files
      try {
        if (fs.existsSync(mergeTempPath)) fs.unlinkSync(mergeTempPath);
      } catch {}
      log.error('Segment merge failed:', mergeErr);
      throw mergeErr;
    }
  }

  /**
   * Calculates SHA-256 of file using streaming chunks to minimize memory footprint.
   */
  static _computeFileSha256(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Safely deletes segment temporary files and their parent directory.
   */
  static _cleanupParts(segments, log) {
    let partsDir = null;
    for (const seg of segments) {
      if (seg.temporary_path && fs.existsSync(seg.temporary_path)) {
        try {
          fs.unlinkSync(seg.temporary_path);
          if (!partsDir) partsDir = path.dirname(seg.temporary_path);
        } catch (e) {
          log.warn(`Failed to clean up segment part ${seg.temporary_path}: ${e.message}`);
        }
      }
    }

    if (partsDir && fs.existsSync(partsDir)) {
      try {
        fs.rmdirSync(partsDir);
      } catch {}
    }
  }
}

module.exports = { SegmentMerger };
