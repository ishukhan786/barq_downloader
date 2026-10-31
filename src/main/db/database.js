'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS: DEFAULT_MIGRATIONS } = require('./migrations');

const REQUIRED_TABLES = ['downloads', 'segments', 'settings', 'events', 'schema_migrations'];

function sidecars(dbPath) {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

function latestOf(migrations) {
  return migrations.reduce((m, x) => Math.max(m, x.version), 0);
}

/**
 * Thin wrapper over node:sqlite (built into Node/Electron — no native addon).
 * Handles pragmas, integrity checks, corruption quarantine, migrations,
 * transactions, backup and restore.
 */
class BarqDatabase {
  /**
   * @param {string} dbPath
   * @param {object} [opts]
   * @param {object} [opts.logger]
   * @param {Array}  [opts.migrations] override (tests)
   */
  constructor(dbPath, { logger, migrations = DEFAULT_MIGRATIONS } = {}) {
    this.dbPath = dbPath;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
    this.latestVersion = latestOf(this.migrations);
    this.db = null;
    /** Set when a corrupt DB was quarantined at open time. */
    this.recoveredFrom = null;
  }

  open() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = this._connect();
    const check = this._quickCheck();
    if (check !== 'ok') {
      this.logger.error('Database failed integrity check; quarantining', { check });
      this.close();
      const stamp = Date.now();
      const quarantined = `${this.dbPath}.corrupt-${stamp}`;
      fs.renameSync(this.dbPath, quarantined);
      for (const s of sidecars(this.dbPath)) {
        if (fs.existsSync(s)) fs.renameSync(s, `${quarantined}${s.slice(this.dbPath.length)}`);
      }
      this.recoveredFrom = quarantined;
      this.db = this._connect();
    }
    this.migrate();
    return this;
  }

  _connect() {
    let db;
    try {
      db = new DatabaseSync(this.dbPath, { enableForeignKeyConstraints: true });
      // WAL keeps the DB consistent if the app is killed mid-write.
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA synchronous = NORMAL;');
      db.exec('PRAGMA foreign_keys = ON;');
      db.exec('PRAGMA busy_timeout = 5000;');
      return db;
    } catch (err) {
      // File is not a database at all (e.g. garbage header) — treat as corrupt.
      if (db) try { db.close(); } catch { /* ignore */ }
      if (fs.existsSync(this.dbPath) && /not a database|malformed|corrupt/i.test(String(err.message))) {
        const quarantined = `${this.dbPath}.corrupt-${Date.now()}`;
        fs.renameSync(this.dbPath, quarantined);
        for (const s of sidecars(this.dbPath)) fs.rmSync(s, { force: true });
        this.recoveredFrom = quarantined;
        this.logger.error('Database unreadable; quarantined and recreated', { quarantined });
        return this._connect();
      }
      throw err;
    }
  }

  _quickCheck() {
    try {
      const row = this.db.prepare('PRAGMA quick_check').get();
      return row ? Object.values(row)[0] : 'no result';
    } catch (err) {
      return String(err.message);
    }
  }

  get userVersion() {
    return this.db.prepare('PRAGMA user_version').get().user_version;
  }

  migrate() {
    const db = this.db;
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  INTEGER NOT NULL
    );`);
    const current = this.userVersion;
    if (current > this.latestVersion) {
      // Safe-upgrade guard: refuse to run an older build against a newer schema.
      const err = new Error(
        `Database schema version ${current} is newer than this build supports (${this.latestVersion}). ` +
        'Please use a newer version of BARQ Downloader.'
      );
      err.code = 'SCHEMA_TOO_NEW';
      throw err;
    }
    const applied = [];
    for (const m of this.migrations) {
      if (m.version <= current) continue;
      this.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(m.version, m.name, Date.now());
        // PRAGMA cannot take bound parameters; version is a trusted integer from code.
        db.exec(`PRAGMA user_version = ${Number(m.version) | 0};`);
      });
      applied.push(m.version);
      this.logger.info('Applied migration', { version: m.version, name: m.name });
    }
    return applied;
  }

  /** Runs fn inside BEGIN IMMEDIATE / COMMIT; rolls back on throw. Not re-entrant. */
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK;'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  /** Writes a consistent, compacted snapshot to destPath (must not exist). */
  backupTo(destPath) {
    if (fs.existsSync(destPath)) {
      const err = new Error('Backup destination already exists.');
      err.code = 'EEXIST';
      throw err;
    }
    this.db.prepare('VACUUM INTO ?').run(destPath);
    return { path: destPath, bytes: fs.statSync(destPath).size };
  }

  /**
   * Validates a candidate backup file without modifying it.
   * @returns {{ ok: true, version: number } | { ok: false, error: string }}
   */
  static inspectBackup(filePath, latestVersion) {
    let db;
    try {
      const header = Buffer.alloc(16);
      const fd = fs.openSync(filePath, 'r');
      try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
      if (header.toString('latin1') !== 'SQLite format 3\u0000') {
        return { ok: false, error: 'The selected file is not a SQLite database.' };
      }
      db = new DatabaseSync(filePath, { readOnly: true });
      const integrity = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
      if (integrity !== 'ok') return { ok: false, error: `Backup failed integrity check: ${integrity}` };
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version < 1) return { ok: false, error: 'The selected file is not a BARQ database.' };
      if (version > latestVersion) {
        return { ok: false, error: `Backup was created by a newer BARQ version (schema ${version}).` };
      }
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
      const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
      if (missing.length) return { ok: false, error: `Backup is missing tables: ${missing.join(', ')}` };
      return { ok: true, version };
    } catch (err) {
      return { ok: false, error: `Could not read backup: ${err.message}` };
    } finally {
      if (db) try { db.close(); } catch { /* ignore */ }
    }
  }

  /**
   * Replaces the live database with a validated backup. A safety snapshot of
   * the current DB is written to safetyDir first. Reopens and migrates after.
   */
  restoreFrom(srcPath, safetyDir) {
    const info = BarqDatabase.inspectBackup(srcPath, this.latestVersion);
    if (!info.ok) {
      const err = new Error(info.error);
      err.code = 'INVALID_BACKUP';
      throw err;
    }
    fs.mkdirSync(safetyDir, { recursive: true });
    const safety = path.join(safetyDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    this.backupTo(safety);
    this.close();
    for (const s of sidecars(this.dbPath)) fs.rmSync(s, { force: true });
    const staging = `${this.dbPath}.restore-tmp`;
    fs.copyFileSync(srcPath, staging);
    fs.renameSync(staging, this.dbPath); // atomic replace on same volume
    this.open();
    return { safetyBackup: safety, version: this.userVersion };
  }

  close() {
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }
}

module.exports = { BarqDatabase, REQUIRED_TABLES };
