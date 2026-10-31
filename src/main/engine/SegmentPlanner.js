'use strict';

const path = require('node:path');

/**
 * Calculates deterministic, non-overlapping, contiguous byte boundaries
 * for multi-segment file downloads using strict integer arithmetic.
 */
class SegmentPlanner {
  /**
   * Plans segment boundaries for a download.
   *
   * @param {object} params
   * @param {number} params.downloadId parent download ID
   * @param {number} params.totalBytes total remote file size in bytes
   * @param {number} [params.connectionCount=8] desired connection count (1-16)
   * @param {number} [params.minSegmentSize=1048576] minimum segment size threshold in bytes (default 1 MB)
   * @param {string} params.destinationPath folder where final file will be saved
   * @param {string} params.filename destination filename
   * @param {string} [params.etag] resource ETag
   * @param {string} [params.lastModified] resource Last-Modified header
   * @returns {{
   *   segmentCount: number,
   *   totalBytes: number,
   *   partsDir: string,
   *   segments: Array<{
   *     download_id: number,
   *     segment_index: number,
   *     start_byte: number,
   *     end_byte: number,
   *     expected_bytes: number,
   *     downloaded_bytes: number,
   *     status: 'pending',
   *     temporary_path: string,
   *     etag: string|null,
   *     last_modified: string|null
   *   }>
   * }}
   */
  static plan({
    downloadId,
    totalBytes,
    connectionCount = 8,
    minSegmentSize = 1048576,
    destinationPath,
    filename,
    etag = null,
    lastModified = null,
  }) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
      throw new Error(`Invalid totalBytes for segment planning: ${totalBytes}`);
    }
    if (!destinationPath || typeof destinationPath !== 'string') {
      throw new Error('Destination path is required for segment planning.');
    }
    if (!filename || typeof filename !== 'string') {
      throw new Error('Filename is required for segment planning.');
    }

    // Clamp desired connections to safe bounds [1, 16]
    let connections = Math.max(1, Math.min(16, Number.isInteger(connectionCount) ? connectionCount : 8));

    // Adapt segment count if file size is small relative to minSegmentSize
    if (minSegmentSize > 0 && totalBytes < connections * minSegmentSize) {
      connections = Math.max(1, Math.floor(totalBytes / minSegmentSize));
    }

    const partsDir = path.join(path.resolve(destinationPath), `${filename}.barq-parts`);

    // Integer division and remainder distribution
    const baseChunk = Math.floor(totalBytes / connections);
    const remainder = totalBytes % connections;

    const segments = [];
    let currentOffset = 0;

    for (let i = 0; i < connections; i++) {
      const segmentLen = baseChunk + (i < remainder ? 1 : 0);
      const start = currentOffset;
      const end = start + segmentLen - 1;
      currentOffset = end + 1;

      const partFilename = `segment-${String(i).padStart(3, '0')}.part`;
      const partPath = path.join(partsDir, partFilename);

      segments.push({
        download_id: downloadId,
        segment_index: i,
        start_byte: start,
        end_byte: end,
        expected_bytes: segmentLen,
        downloaded_bytes: 0,
        status: 'pending',
        temporary_path: partPath,
        etag: etag || null,
        last_modified: lastModified || null,
      });
    }

    // Verification: integrity and boundary checks
    SegmentPlanner.verifyPlan(segments, totalBytes);

    return {
      segmentCount: segments.length,
      totalBytes,
      partsDir,
      segments,
    };
  }

  /**
   * Mathematical verification of segment boundaries:
   * 1. Segment 0 starts at 0.
   * 2. Final segment ends at totalBytes - 1.
   * 3. No gaps (start[i] == end[i-1] + 1).
   * 4. No overlaps.
   * 5. No zero-length segments.
   * 6. Sum of segment lengths equals totalBytes.
   */
  static verifyPlan(segments, expectedTotalBytes) {
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('Segment plan must contain at least one segment.');
    }

    let sumBytes = 0;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (seg.segment_index !== i) {
        throw new Error(`Segment index mismatch at position ${i}: got ${seg.segment_index}`);
      }
      if (seg.start_byte < 0 || seg.end_byte < seg.start_byte) {
        throw new Error(`Invalid byte boundaries for segment ${i}: ${seg.start_byte}-${seg.end_byte}`);
      }

      const len = seg.end_byte - seg.start_byte + 1;
      if (len <= 0) {
        throw new Error(`Zero-length or negative segment at index ${i}`);
      }
      sumBytes += len;

      if (i === 0 && seg.start_byte !== 0) {
        throw new Error(`First segment must start at byte 0, got ${seg.start_byte}`);
      }
      if (i > 0) {
        const prev = segments[i - 1];
        if (seg.start_byte !== prev.end_byte + 1) {
          throw new Error(`Discontinuity or overlap between segment ${i - 1} (ends ${prev.end_byte}) and segment ${i} (starts ${seg.start_byte})`);
        }
      }
      if (i === segments.length - 1 && seg.end_byte !== expectedTotalBytes - 1) {
        throw new Error(`Last segment must end at ${expectedTotalBytes - 1}, got ${seg.end_byte}`);
      }
    }

    if (sumBytes !== expectedTotalBytes) {
      throw new Error(`Total covered bytes (${sumBytes}) does not equal expected total (${expectedTotalBytes})`);
    }

    return true;
  }
}

module.exports = { SegmentPlanner };
