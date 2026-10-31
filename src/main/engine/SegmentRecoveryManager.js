'use strict';

const fs = require('node:fs');

/**
 * Reconciles interrupted multi-segment downloads with verified physical disk state
 * upon application startup or recovery after crash.
 */
class SegmentRecoveryManager {
  /**
   * Scans and recovers unfinished multi-segment downloads.
   *
   * @param {object} ctx
   * @param {import('../db/downloads-repo').DownloadsRepo} ctx.downloadsRepo
   * @param {import('../db/segments-repo').SegmentsRepo} ctx.segmentsRepo
   * @param {import('../db/downloads-repo').EventsRepo} [ctx.eventsRepo]
   * @param {object} [ctx.logger]
   * @returns {Promise<number>} count of recovered segmented downloads
   */
  static async recover({ downloadsRepo, segmentsRepo, eventsRepo, logger }) {
    const log = logger || { info() {}, warn() {}, error() {} };

    try {
      const allUnfinished = downloadsRepo.getUnfinished();
      const segmentedUnfinished = allUnfinished.filter((r) => r.is_segmented === 1);

      if (segmentedUnfinished.length === 0) return 0;

      log.info(`Found ${segmentedUnfinished.length} unfinished segmented download(s) to reconcile.`);

      let recoveredCount = 0;

      for (const rec of segmentedUnfinished) {
        const segments = segmentsRepo.getByDownloadId(rec.id);
        if (segments.length === 0) {
          log.warn(`Segmented download #${rec.id} has no segment records; reverting to single-connection.`);
          downloadsRepo.updateSegmentedInfo(rec.id, {
            is_segmented: 0,
            segment_count: 1,
            fallback_reason: 'Missing segment metadata on restart recovery',
          });
          continue;
        }

        let totalVerifiedBytes = 0;
        let completedSegments = 0;

        for (const seg of segments) {
          const expectedSegBytes = seg.end_byte - seg.start_byte + 1;
          let actualDiskBytes = 0;

          if (fs.existsSync(seg.temporary_path)) {
            try {
              actualDiskBytes = fs.statSync(seg.temporary_path).size;
            } catch {
              actualDiskBytes = 0;
            }
          }

          if (actualDiskBytes === expectedSegBytes) {
            // Segment was fully completed on disk
            segmentsRepo.updateStatus(seg.id, 'completed', {
              downloaded_bytes: actualDiskBytes,
            });
            completedSegments++;
          } else if (actualDiskBytes > 0 && actualDiskBytes < expectedSegBytes) {
            // Segment has partial verified data
            segmentsRepo.updateStatus(seg.id, 'pending', {
              downloaded_bytes: actualDiskBytes,
            });
          } else if (actualDiskBytes > expectedSegBytes) {
            // Disk file oversized/corrupted; safely truncate
            try { fs.truncateSync(seg.temporary_path, 0); } catch {}
            actualDiskBytes = 0;
            segmentsRepo.updateStatus(seg.id, 'pending', {
              downloaded_bytes: 0,
            });
          } else {
            // Missing or empty
            segmentsRepo.updateStatus(seg.id, 'pending', {
              downloaded_bytes: 0,
            });
          }

          totalVerifiedBytes += actualDiskBytes;
        }

        // Reconcile parent record
        downloadsRepo.updateProgress(rec.id, {
          downloaded_bytes: totalVerifiedBytes,
          total_bytes: rec.total_bytes,
          status: 'paused',
        });

        downloadsRepo.updateStatus(rec.id, 'paused', {
          error_code: null,
          error_message: `Interrupted multi-segment download recovered (${completedSegments}/${segments.length} segments complete, ${totalVerifiedBytes} bytes verified on disk). Ready to resume.`,
        });

        if (eventsRepo) {
          eventsRepo.add({
            downloadId: rec.id,
            level: 'info',
            type: 'recovered',
            message: `Segmented download "${rec.filename}" safely recovered: ${completedSegments}/${segments.length} segments intact (${totalVerifiedBytes} bytes).`,
          });
        }

        log.info(`Recovered segmented download #${rec.id} (${rec.filename}): ${totalVerifiedBytes} verified bytes.`);
        recoveredCount++;
      }

      return recoveredCount;
    } catch (err) {
      log.error('Error during multi-segment crash recovery:', err);
      return 0;
    }
  }
}

module.exports = { SegmentRecoveryManager };
