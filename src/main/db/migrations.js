'use strict';

/**
 * Versioned, append-only schema migrations.
 *
 * Rules:
 *  - NEVER edit a migration that has shipped. Add a new one instead.
 *  - Each migration runs inside a single transaction together with its
 *    bookkeeping row, so a crash mid-migration leaves the DB at the
 *    previous version.
 *  - Timestamps are stored as integer milliseconds since the Unix epoch (UTC).
 */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    up(db) {
      db.exec(`
        CREATE TABLE downloads (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          source_url        TEXT    NOT NULL,
          filename          TEXT    NOT NULL,
          destination_path  TEXT    NOT NULL,
          status            TEXT    NOT NULL DEFAULT 'queued'
                            CHECK (status IN ('queued','scheduled','downloading','paused','completed','failed','canceled')),
          total_bytes       INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
          downloaded_bytes  INTEGER NOT NULL DEFAULT 0 CHECK (downloaded_bytes >= 0),
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          completed_at      INTEGER,
          mime_type         TEXT,
          etag              TEXT,
          last_modified     TEXT,
          supports_ranges   INTEGER NOT NULL DEFAULT 0 CHECK (supports_ranges IN (0, 1)),
          error_code        TEXT,
          error_message     TEXT,
          task_type         TEXT    NOT NULL DEFAULT 'http' CHECK (task_type IN ('http','video')),
          category          TEXT    NOT NULL DEFAULT 'other',
          queue_position    INTEGER NOT NULL DEFAULT 0,
          speed_limit_bps   INTEGER NOT NULL DEFAULT 0 CHECK (speed_limit_bps >= 0),
          max_segments      INTEGER NOT NULL DEFAULT 0 CHECK (max_segments >= 0),
          scheduled_at      INTEGER
        );

        CREATE TABLE segments (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          download_id       INTEGER NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
          segment_index     INTEGER NOT NULL CHECK (segment_index >= 0),
          start_byte        INTEGER NOT NULL CHECK (start_byte >= 0),
          end_byte          INTEGER NOT NULL CHECK (end_byte >= start_byte),
          downloaded_bytes  INTEGER NOT NULL DEFAULT 0
                            CHECK (downloaded_bytes >= 0 AND downloaded_bytes <= end_byte - start_byte + 1),
          status            TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','downloading','completed','failed')),
          retry_count       INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
          temporary_path    TEXT    NOT NULL,
          UNIQUE (download_id, segment_index)
        );

        CREATE TABLE settings (
          key         TEXT PRIMARY KEY NOT NULL,
          value       TEXT NOT NULL,
          updated_at  INTEGER NOT NULL
        );

        CREATE TABLE events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          download_id  INTEGER REFERENCES downloads(id) ON DELETE SET NULL,
          level        TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
          type         TEXT NOT NULL,
          message      TEXT NOT NULL,
          created_at   INTEGER NOT NULL
        );

        CREATE INDEX idx_downloads_status        ON downloads(status);
        CREATE INDEX idx_downloads_created_at    ON downloads(created_at DESC);
        CREATE INDEX idx_downloads_queue         ON downloads(status, queue_position);
        CREATE INDEX idx_downloads_task_type     ON downloads(task_type);
        CREATE INDEX idx_segments_download       ON segments(download_id);
        CREATE INDEX idx_events_created_at       ON events(created_at DESC);
        CREATE INDEX idx_events_download         ON events(download_id);
      `);
    },
  },
  {
    version: 2,
    name: 'download_engine_v2',
    up(db) {
      db.exec(`
        ALTER TABLE downloads ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0);
        ALTER TABLE downloads ADD COLUMN partial_path TEXT;
      `);
    },
  },
  {
    version: 3,
    name: 'multi_segment_engine',
    up(db) {
      db.exec(`
        ALTER TABLE downloads ADD COLUMN is_segmented INTEGER NOT NULL DEFAULT 0 CHECK (is_segmented IN (0, 1));
        ALTER TABLE downloads ADD COLUMN segment_count INTEGER NOT NULL DEFAULT 1 CHECK (segment_count >= 1);
        ALTER TABLE downloads ADD COLUMN fallback_reason TEXT;
        ALTER TABLE segments ADD COLUMN error_code TEXT;
        ALTER TABLE segments ADD COLUMN error_message TEXT;
        ALTER TABLE segments ADD COLUMN etag TEXT;
        ALTER TABLE segments ADD COLUMN last_modified TEXT;
        ALTER TABLE segments ADD COLUMN updated_at INTEGER;
      `);
    },
  },
  {
    version: 4,
    name: 'feedback_system',
    up(db) {
      db.exec(`
        CREATE TABLE feedback_reports (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          report_id            TEXT    UNIQUE NOT NULL,
          report_type          TEXT    NOT NULL CHECK (report_type IN ('bug', 'feature')),
          title                TEXT    NOT NULL,
          category             TEXT    NOT NULL,
          severity             TEXT    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
          description          TEXT    NOT NULL,
          reproduction_steps   TEXT,
          expected_behavior    TEXT,
          actual_behavior      TEXT,
          status               TEXT    NOT NULL DEFAULT 'saved' CHECK (status IN ('draft', 'saved', 'exported', 'ready')),
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL,
          exported_at          INTEGER,
          diagnostic_included  INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic_included IN (0, 1))
        );

        CREATE INDEX idx_feedback_created_at ON feedback_reports(created_at DESC);
        CREATE INDEX idx_feedback_type       ON feedback_reports(report_type);
        CREATE INDEX idx_feedback_status     ON feedback_reports(status);
      `);
    },
  },
  {
    version: 5,
    name: 'feedback_lifecycle_refinement',
    up(db) {
      db.exec(`
        ALTER TABLE feedback_reports ADD COLUMN is_exported INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0, 1));
        UPDATE feedback_reports SET is_exported = 1 WHERE exported_at IS NOT NULL OR status = 'exported';
        UPDATE feedback_reports SET status = 'saved' WHERE status = 'exported';
        CREATE INDEX idx_feedback_exported ON feedback_reports(is_exported);
      `);
    },
  },
];

const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

module.exports = { MIGRATIONS, LATEST_VERSION };
