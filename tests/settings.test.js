'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BarqDatabase } = require('../src/main/db/database');
const { SettingsRepo } = require('../src/main/db/settings-repo');
const { buildSchema } = require('../src/main/settings-schema');

const TEST_DIR = path.join(__dirname, '..', 'test-data', `settings-test-${Date.now()}`);

test.beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

test.afterEach(() => {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
});

test('settings: returns defaults when clean database', () => {
  const dbFile = path.join(TEST_DIR, 'set.db');
  const db = new BarqDatabase(dbFile).open();
  const schema = buildSchema({ defaultDownloadDir: 'C:\\Users\\User\\Downloads' });
  const repo = new SettingsRepo(db, schema);

  try {
    const all = repo.getAll();
    assert.equal(all.theme, 'dark');
    assert.equal(all.maxConcurrentDownloads, 3);
    assert.equal(all.maxSegments, 4);
    assert.equal(all.globalSpeedLimitKBps, 0);
    assert.equal(all.notifications, true);
    assert.equal(all.downloadDir, 'C:\\Users\\User\\Downloads');
  } finally {
    db.close();
  }
});

test('settings: accepts valid updates and persists to database', () => {
  const dbFile = path.join(TEST_DIR, 'set.db');
  const db = new BarqDatabase(dbFile).open();
  const schema = buildSchema({ defaultDownloadDir: 'C:\\Downloads' });
  const repo = new SettingsRepo(db, schema);

  try {
    const res = repo.update({
      theme: 'light',
      maxConcurrentDownloads: 6,
      maxSegments: 8,
      notifications: false,
    });

    assert.equal(res.ok, true);
    assert.equal(res.settings.theme, 'light');
    assert.equal(res.settings.maxConcurrentDownloads, 6);
    assert.equal(res.settings.maxSegments, 8);
    assert.equal(res.settings.notifications, false);

    // Verify raw row in SQLite
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('theme');
    assert.equal(JSON.parse(row.value), 'light');
  } finally {
    db.close();
  }
});

test('settings: rejects out-of-bounds, invalid types, and unknown keys', () => {
  const dbFile = path.join(TEST_DIR, 'set.db');
  const db = new BarqDatabase(dbFile).open();
  const schema = buildSchema({ defaultDownloadDir: 'C:\\Downloads' });
  const repo = new SettingsRepo(db, schema);

  try {
    // Out-of-bounds concurrency
    assert.equal(repo.update({ maxConcurrentDownloads: 999 }).ok, false);
    assert.equal(repo.update({ maxConcurrentDownloads: 0 }).ok, false);
    assert.equal(repo.update({ maxConcurrentDownloads: 'five' }).ok, false);

    // Invalid theme
    assert.equal(repo.update({ theme: 'rainbow' }).ok, false);

    // Unknown setting
    assert.equal(repo.update({ arbitraryMaliciousKey: true }).ok, false);
  } finally {
    db.close();
  }
});

test('settings: blocks renderer writes to non-renderer-writable keys', () => {
  const dbFile = path.join(TEST_DIR, 'set.db');
  const db = new BarqDatabase(dbFile).open();
  const schema = buildSchema({ defaultDownloadDir: 'C:\\Downloads' });
  const repo = new SettingsRepo(db, schema);

  try {
    // Untrusted (default from renderer)
    const blocked = repo.update({ downloadDir: 'C:\\Windows\\System32' }, { trusted: false });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /cannot be changed directly/i);

    // Trusted (main process native picker)
    const allowed = repo.update({ downloadDir: 'D:\\MyDownloads' }, { trusted: true });
    assert.equal(allowed.ok, true);
    assert.equal(allowed.settings.downloadDir, 'D:\\MyDownloads');
  } finally {
    db.close();
  }
});
