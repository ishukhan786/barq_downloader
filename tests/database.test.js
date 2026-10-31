'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo, EventsRepo } = require('../src/main/db/downloads-repo');

const TEST_DIR = path.join(__dirname, '..', 'test-data', `db-test-${Date.now()}`);

test.beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

test.afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

test('db: initializes, applies migrations, and sets pragmas', () => {
  const dbFile = path.join(TEST_DIR, 'test.db');
  const barqDb = new BarqDatabase(dbFile).open();

  try {
    assert.equal(barqDb.userVersion >= 1, true);

    const tables = barqDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    for (const expected of ['downloads', 'segments', 'settings', 'events', 'schema_migrations']) {
      assert.equal(tables.includes(expected), true, `Missing table ${expected}`);
    }

    const journalMode = Object.values(barqDb.prepare('PRAGMA journal_mode').get())[0];
    assert.equal(journalMode.toLowerCase(), 'wal');
  } finally {
    barqDb.close();
  }
});

test('db: transactions commit on success and rollback on throw', () => {
  const dbFile = path.join(TEST_DIR, 'tx.db');
  const barqDb = new BarqDatabase(dbFile).open();

  try {
    // Successful transaction
    barqDb.transaction((db) => {
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('k1', '"v1"', 100);
    });
    const row = barqDb.prepare('SELECT value FROM settings WHERE key = ?').get('k1');
    assert.equal(row.value, '"v1"');

    // Failing transaction
    assert.throws(() => {
      barqDb.transaction((db) => {
        db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('k2', '"v2"', 200);
        throw new Error('Simulated failure');
      });
    });

    const rolledBack = barqDb.prepare('SELECT value FROM settings WHERE key = ?').get('k2');
    assert.equal(rolledBack, undefined);
  } finally {
    barqDb.close();
  }
});

test('db: foreign keys cascade when a download is removed', () => {
  const dbFile = path.join(TEST_DIR, 'fk.db');
  const barqDb = new BarqDatabase(dbFile).open();
  const repo = new DownloadsRepo(barqDb);

  try {
    const dlId = repo.insert({
      source_url: 'https://example.com/file.zip',
      filename: 'file.zip',
      destination_path: 'C:\\Downloads',
      status: 'downloading',
      total_bytes: 1000,
    });

    barqDb.prepare(`
      INSERT INTO segments (download_id, segment_index, start_byte, end_byte, downloaded_bytes, status, temporary_path)
      VALUES (?, 0, 0, 499, 500, 'completed', 'C:\\temp\\part0')
    `).run(dlId);

    const segsBefore = barqDb.prepare('SELECT COUNT(*) c FROM segments WHERE download_id = ?').get(dlId).c;
    assert.equal(segsBefore, 1);

    repo.remove(dlId);

    const segsAfter = barqDb.prepare('SELECT COUNT(*) c FROM segments WHERE download_id = ?').get(dlId).c;
    assert.equal(segsAfter, 0);
  } finally {
    barqDb.close();
  }
});

test('db: backup and restore functions accurately', () => {
  const dbFile = path.join(TEST_DIR, 'live.db');
  const backupFile = path.join(TEST_DIR, 'snapshot.db');
  const safetyDir = path.join(TEST_DIR, 'safety');

  const barqDb = new BarqDatabase(dbFile).open();
  const repo = new DownloadsRepo(barqDb);

  try {
    repo.insert({
      source_url: 'https://example.com/item.iso',
      filename: 'item.iso',
      destination_path: 'C:\\Downloads',
      status: 'completed',
      total_bytes: 4096,
      downloaded_bytes: 4096,
    });

    const res = barqDb.backupTo(backupFile);
    assert.equal(fs.existsSync(backupFile), true);
    assert.equal(res.bytes > 0, true);

    const inspect = BarqDatabase.inspectBackup(backupFile, barqDb.latestVersion);
    assert.equal(inspect.ok, true);

    // Modify live database
    repo.insert({
      source_url: 'https://example.com/another.zip',
      filename: 'another.zip',
      destination_path: 'C:\\Downloads',
      status: 'queued',
    });
    assert.equal(repo.list().length, 2);

    // Restore from backup
    const rest = barqDb.restoreFrom(backupFile, safetyDir);
    assert.equal(rest.version, inspect.version);
    assert.equal(fs.existsSync(rest.safetyBackup), true);

    // Verified: only original 1 item remains after restore
    assert.equal(repo.list().length, 1);
    assert.equal(repo.list()[0].filename, 'item.iso');
  } finally {
    barqDb.close();
  }
});

test('db: corrupt database file is quarantined on startup', () => {
  const dbFile = path.join(TEST_DIR, 'corrupt.db');
  // Write garbage to simulate corruption
  fs.writeFileSync(dbFile, 'GARBAGE NOT SQLITE DATA AT ALL 1234567890');

  const logger = { info() {}, warn() {}, error() {} };
  const barqDb = new BarqDatabase(dbFile, { logger }).open();

  try {
    assert.notEqual(barqDb.recoveredFrom, null);
    assert.equal(fs.existsSync(barqDb.recoveredFrom), true);

    // Fresh db works properly now
    assert.equal(barqDb.userVersion >= 1, true);
  } finally {
    barqDb.close();
  }
});

test('db: EventsRepo logs and prunes properly', () => {
  const dbFile = path.join(TEST_DIR, 'events.db');
  const barqDb = new BarqDatabase(dbFile).open();
  const events = new EventsRepo(barqDb);

  try {
    for (let i = 0; i < 50; i++) {
      events.add({ type: 'test', message: `Event ${i}` });
    }

    const recent = events.recent(10);
    assert.equal(recent.length, 10);
    assert.equal(recent[0].message, 'Event 49');

    events.prune(20);
    const totalRemaining = barqDb.prepare('SELECT COUNT(*) c FROM events').get().c;
    assert.equal(totalRemaining, 20);
  } finally {
    barqDb.close();
  }
});
