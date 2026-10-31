'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

class DatabaseBackupManager {
  /**
   * @param {object} opts
   * @param {import('./database').BarqDatabase} opts.database Live BarqDatabase instance
   * @param {string} [opts.backupsDir] Dedicated directory for automated pre-migration backups
   * @param {string} [opts.dataDir] Application data directory (backups will be stored in dataDir/backups)
   * @param {number} [opts.maxBackups] Maximum number of backups to keep (default: 5)
   * @param {object} [opts.logger]
   */
  constructor({ database, backupsDir, dataDir, maxBackups = 5, logger = console }) {
    this.database = database;
    this.backupsDir = backupsDir || (dataDir ? path.join(dataDir, 'backups') : null);
    this.maxBackups = maxBackups;
    this.logger = logger;
  }

  /**
   * Computes SHA-256 hash of a file.
   * @param {string} filePath
   * @returns {string}
   */
  static fileHash(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Creates an automated, WAL-consistent snapshot before running any new migrations.
   * @param {string} [reason] Human-readable reason for the snapshot
   * @returns {{ path: string, version: number, sha256: string, tablesCount: number, metaPath: string }}
   */
  createPreMigrationBackup(reason = 'pre-migration-upgrade') {
    fs.mkdirSync(this.backupsDir, { recursive: true });

    const currentVersion = this.database.userVersion;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `barq-backup-v${currentVersion}-${stamp}.db`;
    const backupPath = path.join(this.backupsDir, backupFilename);
    const metaPath = path.join(this.backupsDir, `barq-backup-v${currentVersion}-${stamp}.meta.json`);

    this.logger.info(`Creating consistent pre-migration backup at: ${backupPath}`);

    // 1. Execute WAL-consistent snapshot using VACUUM INTO
    this.database.backupTo(backupPath);

    // 2. Verify backup integrity
    let testDb;
    let tablesCount = 0;
    try {
      testDb = new DatabaseSync(backupPath, { readOnly: true });
      const integrity = Object.values(testDb.prepare('PRAGMA integrity_check').get())[0];
      if (integrity !== 'ok') {
        throw new Error(`Backup failed integrity verification: ${integrity}`);
      }
      const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      tablesCount = tables.length;
    } finally {
      if (testDb) try { testDb.close(); } catch {}
    }

    // 3. Write metadata record
    const sha256 = DatabaseBackupManager.fileHash(backupPath);
    const metadata = {
      timestamp: Date.now(),
      isoDate: new Date().toISOString(),
      reason,
      schemaVersion: currentVersion,
      backupFile: backupFilename,
      backupPath,
      sha256,
      tablesCount,
      dbFileSize: fs.statSync(backupPath).size,
    };

    fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    this.logger.info(`Backup verified and metadata recorded at ${metaPath}`);

    this.pruneBackups(this.maxBackups);

    return {
      path: backupPath,
      version: currentVersion,
      sha256,
      tablesCount,
      metaPath,
    };
  }

  /**
   * Prunes oldest backups beyond maxKeep limit.
   * @param {number} [maxKeep]
   * @returns {number} count of pruned backups
   */
  pruneBackups(maxKeep = this.maxBackups) {
    if (!maxKeep || maxKeep <= 0) return 0;
    const backups = this.listBackups();
    if (backups.length <= maxKeep) return 0;

    const toRemove = backups.slice(maxKeep);
    let removed = 0;
    for (const b of toRemove) {
      try {
        if (fs.existsSync(b.backupPath)) fs.unlinkSync(b.backupPath);
        const metaPath = b.backupPath.replace(/\.db$/, '') + '.meta.json';
        if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        removed++;
      } catch {}
    }
    return removed;
  }

  /**
   * Lists available automated backups with their verification statuses.
   * @returns {Array<object>}
   */
  listBackups() {
    if (!fs.existsSync(this.backupsDir)) return [];

    const files = fs.readdirSync(this.backupsDir);
    const metaFiles = files.filter((f) => f.endsWith('.meta.json'));

    const backups = [];
    for (const mf of metaFiles) {
      try {
        const fullMetaPath = path.join(this.backupsDir, mf);
        const meta = JSON.parse(fs.readFileSync(fullMetaPath, 'utf8'));
        const dbFileExists = fs.existsSync(meta.backupPath);
        backups.push({
          ...meta,
          existsOnDisk: dbFileExists,
        });
      } catch {}
    }

    return backups.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Rolls back live database to a verified backup snapshot.
   * @param {string} backupDbPath Full path to the verified backup file
   */
  rollbackTo(backupDbPath) {
    if (!fs.existsSync(backupDbPath)) {
      throw new Error(`Rollback failed: backup file does not exist at ${backupDbPath}`);
    }

    const safetyDir = path.join(this.backupsDir, 'safety-before-rollback');
    fs.mkdirSync(safetyDir, { recursive: true });

    this.logger.warn(`Restoring database from backup ${backupDbPath}`);
    this.database.restoreFrom(backupDbPath, safetyDir);
    this.logger.info('Database successfully rolled back and re-opened.');
  }
}

module.exports = { DatabaseBackupManager };
