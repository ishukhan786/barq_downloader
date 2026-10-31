'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BarqDatabase } = require('../src/main/db/database');
const { DatabaseBackupManager } = require('../src/main/db/backup-manager');

test('BARQ Downloader — Milestone 8 Database Backup & Rollback Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-backup-test-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new BarqDatabase(dbPath);
  db.open();

  const backupManager = new DatabaseBackupManager({
    database: db,
    dataDir: tmpDir,
    maxBackups: 3,
  });

  t.after(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1.1: Creates pre-migration backup and verified .meta.json file', () => {
    const backup = backupManager.createPreMigrationBackup('test-pre-migration');
    assert.ok(backup.path, 'Backup path should be returned');
    assert.ok(fs.existsSync(backup.path), 'Backup file must exist on disk');
    assert.ok(fs.existsSync(backup.metaPath), 'Metadata file must exist');

    const meta = JSON.parse(fs.readFileSync(backup.metaPath, 'utf8'));
    assert.equal(meta.reason, 'test-pre-migration');
    assert.ok(meta.tablesCount >= 5);
    assert.ok(meta.sha256 && meta.sha256.length === 64);
  });

  await t.test('1.2: Verifies database snapshot integrity and structure', () => {
    const backup = backupManager.createPreMigrationBackup('integrity-test');
    assert.ok(backup.sha256);
    assert.ok(backup.tablesCount > 0);
  });

  await t.test('1.3: Lists available backups sorted chronologically descending', () => {
    const list = backupManager.listBackups();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 2);
    for (let i = 0; i < list.length - 1; i++) {
      assert.ok(list[i].timestamp >= list[i + 1].timestamp);
    }
  });

  await t.test('1.4: Enforces maxBackups pruning policy cleanly', () => {
    // Already have 2 backups, create 3 more (total 5) with maxBackups: 3
    backupManager.createPreMigrationBackup('prune-test-1');
    backupManager.createPreMigrationBackup('prune-test-2');
    backupManager.createPreMigrationBackup('prune-test-3');

    const list = backupManager.listBackups();
    assert.equal(list.length, 3, 'Should be pruned to maxBackups (3)');
  });

  await t.test('1.5: Successfully rolls back to a verified backup snapshot', () => {
    const list = backupManager.listBackups();
    const targetBackup = list[0];

    assert.doesNotThrow(() => {
      backupManager.rollbackTo(targetBackup.backupPath);
    });
  });
});
