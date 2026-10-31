'use strict';

/**
 * Repository for segment-level persistence in SQLite.
 */
class SegmentsRepo {
  /**
   * @param {import('./database').BarqDatabase} database
   */
  constructor(database) {
    this.database = database;
  }

  /**
   * Inserts a batch of planned segments atomically in a single transaction.
   *
   * @param {Array<{
   *   download_id: number,
   *   segment_index: number,
   *   start_byte: number,
   *   end_byte: number,
   *   downloaded_bytes?: number,
   *   status?: string,
   *   temporary_path: string,
   *   etag?: string,
   *   last_modified?: string
   * }>} segments
   * @returns {number[]} array of inserted segment IDs
   */
  insertBatch(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return [];

    const now = Date.now();
    const insertStmt = this.database.prepare(`
      INSERT INTO segments (
        download_id, segment_index, start_byte, end_byte, downloaded_bytes,
        status, retry_count, temporary_path, etag, last_modified, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ids = [];
    this.database.transaction(() => {
      for (const seg of segments) {
        const res = insertStmt.run(
          seg.download_id,
          seg.segment_index,
          seg.start_byte,
          seg.end_byte,
          seg.downloaded_bytes || 0,
          seg.status || 'pending',
          0,
          seg.temporary_path,
          seg.etag || null,
          seg.last_modified || null,
          now
        );
        ids.push(Number(res.lastInsertRowid));
      }
    });

    return ids;
  }

  /**
   * Returns all segments for a download, ordered sequentially by segment index.
   *
   * @param {number} downloadId
   * @returns {Array<object>}
   */
  getByDownloadId(downloadId) {
    return this.database.prepare(`
      SELECT
        id, download_id, segment_index, start_byte, end_byte,
        downloaded_bytes, status, retry_count, temporary_path,
        error_code, error_message, etag, last_modified, updated_at
      FROM segments
      WHERE download_id = ?
      ORDER BY segment_index ASC
    `).all(downloadId);
  }

  /**
   * Returns a single segment by ID.
   *
   * @param {number} id
   * @returns {object|null}
   */
  getById(id) {
    return this.database.prepare(`
      SELECT
        id, download_id, segment_index, start_byte, end_byte,
        downloaded_bytes, status, retry_count, temporary_path,
        error_code, error_message, etag, last_modified, updated_at
      FROM segments
      WHERE id = ?
    `).get(id) || null;
  }

  /**
   * Updates downloaded byte progress for a segment.
   *
   * @param {number} id
   * @param {number} downloadedBytes
   */
  updateProgress(id, downloadedBytes) {
    const now = Date.now();
    return this.database.prepare(`
      UPDATE segments
      SET downloaded_bytes = ?, updated_at = ?
      WHERE id = ?
    `).run(downloadedBytes, now, id);
  }

  /**
   * Updates segment status and error/metadata.
   *
   * @param {number} id
   * @param {string} status
   * @param {object} [extra]
   */
  updateStatus(id, status, { error_code = null, error_message = null, etag = null, last_modified = null, downloaded_bytes } = {}) {
    const now = Date.now();
    if (downloaded_bytes !== undefined) {
      return this.database.prepare(`
        UPDATE segments
        SET status = ?, error_code = ?, error_message = ?, etag = COALESCE(?, etag),
            last_modified = COALESCE(?, last_modified), downloaded_bytes = ?, updated_at = ?
        WHERE id = ?
      `).run(status, error_code, error_message, etag, last_modified, downloaded_bytes, now, id);
    }
    return this.database.prepare(`
      UPDATE segments
      SET status = ?, error_code = ?, error_message = ?, etag = COALESCE(?, etag),
          last_modified = COALESCE(?, last_modified), updated_at = ?
      WHERE id = ?
    `).run(status, error_code, error_message, etag, last_modified, now, id);
  }

  /**
   * Increments retry count and sets status to pending for retry.
   *
   * @param {number} id
   * @param {string} [errorCode]
   * @param {string} [errorMessage]
   */
  resetForRetry(id, errorCode = null, errorMessage = null) {
    const now = Date.now();
    return this.database.prepare(`
      UPDATE segments
      SET status = 'pending', retry_count = retry_count + 1,
          error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(errorCode, errorMessage, now, id);
  }

  /**
   * Deletes all segments for a download.
   *
   * @param {number} downloadId
   */
  deleteByDownloadId(downloadId) {
    return this.database.prepare(`
      DELETE FROM segments WHERE download_id = ?
    `).run(downloadId);
  }

  /**
   * Returns aggregated statistics for segments of a download.
   *
   * @param {number} downloadId
   * @returns {{ total: number, completed: number, active: number, pending: number, failed: number, downloadedBytes: number }}
   */
  getStats(downloadId) {
    const row = this.database.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(status = 'completed'), 0) AS completed,
        COALESCE(SUM(status = 'downloading'), 0) AS active,
        COALESCE(SUM(status = 'pending'), 0) AS pending,
        COALESCE(SUM(status = 'failed'), 0) AS failed,
        COALESCE(SUM(downloaded_bytes), 0) AS downloadedBytes
      FROM segments
      WHERE download_id = ?
    `).get(downloadId);

    return {
      total: row.total || 0,
      completed: row.completed || 0,
      active: row.active || 0,
      pending: row.pending || 0,
      failed: row.failed || 0,
      downloadedBytes: row.downloadedBytes || 0,
    };
  }
}

module.exports = { SegmentsRepo };
