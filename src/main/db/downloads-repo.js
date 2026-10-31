'use strict';

const { categorize } = require('../../shared/categories');

/** Navigation views → SQL predicates. Only these fixed fragments are ever interpolated. */
const VIEW_FILTERS = Object.freeze({
  all: '1 = 1',
  downloading: "status = 'downloading'",
  queued: "status IN ('queued','scheduled')",
  paused: "status = 'paused'",
  completed: "status = 'completed'",
  failed: "status IN ('failed','canceled')",
  video: "task_type = 'video'",
});

const LIST_COLUMNS = `id, source_url, filename, destination_path, status, total_bytes, downloaded_bytes,
  created_at, updated_at, completed_at, mime_type, supports_ranges, error_code, error_message,
  task_type, category, queue_position, scheduled_at, retry_count, partial_path,
  is_segmented, segment_count, fallback_reason`;

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

class DownloadsRepo {
  constructor(database) {
    this.database = database;
  }

  /**
   * @param {{ view?: string, search?: string, limit?: number }} q
   */
  list({ view = 'all', search = '', limit = 500 } = {}) {
    const where = VIEW_FILTERS[view];
    if (!where) throw new Error(`Unknown view "${view}"`);
    const lim = Number.isSafeInteger(limit) && limit > 0 && limit <= 5000 ? limit : 500;
    const params = [];
    let sql = `SELECT ${LIST_COLUMNS} FROM downloads WHERE ${where}`;
    const term = typeof search === 'string' ? search.trim().slice(0, 200) : '';
    if (term) {
      sql += " AND (filename LIKE ? ESCAPE '\\' OR source_url LIKE ? ESCAPE '\\')";
      const like = `%${escapeLike(term)}%`;
      params.push(like, like);
    }
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(lim);
    return this.database.prepare(sql).all(...params);
  }

  getById(id) {
    return this.database.prepare(`SELECT ${LIST_COLUMNS}, etag, last_modified FROM downloads WHERE id = ?`).get(id) || null;
  }

  stats() {
    const row = this.database.prepare(`
      SELECT
        COUNT(*)                                                         AS total,
        COALESCE(SUM(status = 'downloading'), 0)                         AS active,
        COALESCE(SUM(status IN ('queued','scheduled')), 0)               AS queued,
        COALESCE(SUM(status = 'paused'), 0)                              AS paused,
        COALESCE(SUM(status = 'completed'), 0)                           AS completed,
        COALESCE(SUM(status IN ('failed','canceled')), 0)                AS failed,
        COALESCE(SUM(task_type = 'video'), 0)                            AS video,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN downloaded_bytes ELSE 0 END), 0) AS completed_bytes,
        COALESCE(SUM(downloaded_bytes), 0)                               AS total_downloaded_bytes
      FROM downloads`).get();
    return { ...row };
  }

  /** Queue preview for the dashboard (ordered as the scheduler will run them). */
  queue(limit = 10) {
    return this.database.prepare(
      `SELECT ${LIST_COLUMNS} FROM downloads WHERE status IN ('downloading','queued','scheduled')
       ORDER BY CASE status WHEN 'downloading' THEN 0 ELSE 1 END, queue_position ASC, created_at ASC LIMIT ?`
    ).all(limit);
  }

  /**
   * Inserts a download record. Used by the engine (Milestone 2+) and tests.
   */
  insert(d) {
    const now = Date.now();
    const res = this.database.prepare(`
      INSERT INTO downloads (source_url, filename, destination_path, status, total_bytes, downloaded_bytes,
        created_at, updated_at, completed_at, mime_type, etag, last_modified, supports_ranges,
        error_code, error_message, task_type, category, queue_position, speed_limit_bps, max_segments, scheduled_at,
        retry_count, partial_path, is_segmented, segment_count, fallback_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      d.source_url, d.filename, d.destination_path, d.status || 'queued',
      d.total_bytes ?? null, d.downloaded_bytes ?? 0,
      d.created_at ?? now, now, d.completed_at ?? null,
      d.mime_type ?? null, d.etag ?? null, d.last_modified ?? null, d.supports_ranges ? 1 : 0,
      d.error_code ?? null, d.error_message ?? null, d.task_type || 'http',
      d.category || categorize(d.filename, d.mime_type), d.queue_position ?? 0,
      d.speed_limit_bps ?? 0, d.max_segments ?? 0, d.scheduled_at ?? null,
      d.retry_count ?? 0, d.partial_path ?? null,
      d.is_segmented ? 1 : 0, Math.max(1, d.segment_count || 1), d.fallback_reason ?? null
    );
    return Number(res.lastInsertRowid);
  }

  /**
   * Updates download progress (bytes and optionally total).
   */
  updateProgress(id, { downloaded_bytes, total_bytes, status }) {
    const now = Date.now();
    if (total_bytes !== undefined) {
      return this.database.prepare(`
        UPDATE downloads SET downloaded_bytes = ?, total_bytes = ?, status = COALESCE(?, status), updated_at = ?
        WHERE id = ?
      `).run(downloaded_bytes, total_bytes, status || null, now, id);
    }
    return this.database.prepare(`
      UPDATE downloads SET downloaded_bytes = ?, status = COALESCE(?, status), updated_at = ?
      WHERE id = ?
    `).run(downloaded_bytes, status || null, now, id);
  }

  /**
   * Updates state transition (status, errors, completion, partial path).
   */
  updateStatus(id, status, { error_code = null, error_message = null, completed_at = null, partial_path } = {}) {
    const now = Date.now();
    if (partial_path !== undefined) {
      return this.database.prepare(`
        UPDATE downloads SET status = ?, error_code = ?, error_message = ?, completed_at = ?, partial_path = ?, updated_at = ?
        WHERE id = ?
      `).run(status, error_code, error_message, completed_at, partial_path, now, id);
    }
    return this.database.prepare(`
      UPDATE downloads SET status = ?, error_code = ?, error_message = ?, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(status, error_code, error_message, completed_at, now, id);
  }

  /**
   * Updates discovered HTTP metadata during probe or start.
   */
  updateMetadata(id, meta) {
    const now = Date.now();
    return this.database.prepare(`
      UPDATE downloads SET
        mime_type = COALESCE(?, mime_type),
        etag = COALESCE(?, etag),
        last_modified = COALESCE(?, last_modified),
        supports_ranges = COALESCE(?, supports_ranges),
        total_bytes = COALESCE(?, total_bytes),
        filename = COALESCE(?, filename),
        category = COALESCE(?, category),
        partial_path = COALESCE(?, partial_path),
        updated_at = ?
      WHERE id = ?
    `).run(
      meta.mime_type ?? null,
      meta.etag ?? null,
      meta.last_modified ?? null,
      meta.supports_ranges !== undefined ? (meta.supports_ranges ? 1 : 0) : null,
      meta.total_bytes ?? null,
      meta.filename ?? null,
      meta.category ?? null,
      meta.partial_path ?? null,
      now,
      id
    );
  }

  /**
   * Updates segmented execution details.
   */
  updateSegmentedInfo(id, { is_segmented, segment_count, fallback_reason = null }) {
    const now = Date.now();
    return this.database.prepare(`
      UPDATE downloads SET
        is_segmented = ?,
        segment_count = COALESCE(?, segment_count),
        fallback_reason = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      is_segmented ? 1 : 0,
      segment_count !== undefined ? Math.max(1, segment_count) : null,
      fallback_reason,
      now,
      id
    );
  }

  /**
   * Increments retry count and sets error details.
   */
  incrementRetry(id, errorCode, errorMessage) {
    const now = Date.now();
    return this.database.prepare(`
      UPDATE downloads SET retry_count = retry_count + 1, error_code = ?, error_message = ?, updated_at = ?
      WHERE id = ?
    `).run(errorCode, errorMessage, now, id);
  }

  /**
   * Resets retry count to 0.
   */
  resetRetry(id) {
    const now = Date.now();
    return this.database.prepare(`
      UPDATE downloads SET retry_count = 0, error_code = null, error_message = null, updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  /**
   * Returns all downloads that were in-progress or queued when the app last stopped.
   */
  getUnfinished() {
    return this.database.prepare(
      `SELECT ${LIST_COLUMNS}, etag, last_modified FROM downloads WHERE status IN ('downloading', 'queued', 'scheduled')`
    ).all();
  }

  /** Removes a record from history (segments cascade). Does not touch files. */
  remove(id) {
    return Number(this.database.prepare('DELETE FROM downloads WHERE id = ?').run(id).changes) > 0;
  }
}

class EventsRepo {
  constructor(database) {
    this.database = database;
  }

  add({ downloadId = null, level = 'info', type, message }) {
    this.database.prepare('INSERT INTO events (download_id, level, type, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(downloadId, level, String(type).slice(0, 64), String(message).slice(0, 1000), Date.now());
  }

  recent(limit = 20) {
    return this.database.prepare(
      'SELECT id, download_id, level, type, message, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(limit);
  }

  /** Keeps the activity log bounded. */
  prune(keep = 2000) {
    this.database.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)').run(keep);
  }
}

module.exports = { DownloadsRepo, EventsRepo, VIEW_FILTERS };
