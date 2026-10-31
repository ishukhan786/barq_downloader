'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { resolveDataDir, buildDataLayout, isWritableDir } = require('../src/main/paths');

test('paths: isWritableDir returns true for writable dir and false for invalid', (t) => {
  const tmp = path.join(__dirname, '..', 'test-data', `probe-${Date.now()}`);
  assert.equal(isWritableDir(tmp), true);
  fs.rmSync(tmp, { recursive: true, force: true });

  const invalidMockFs = {
    mkdirSync() {},
    writeFileSync() { throw new Error('EACCES: permission denied'); },
  };
  assert.equal(isWritableDir('Z:\\restricted', invalidMockFs), false);
});

test('paths: resolveDataDir respects BARQ_DATA_DIR override', () => {
  const custom = path.resolve('D:\\custom-barq-data');
  const res = resolveDataDir({
    isPackaged: false,
    execPath: 'D:\\app\\barq.exe',
    appRoot: 'D:\\app',
    fallbackBase: 'C:\\Users\\User\\AppData\\Local',
    env: { BARQ_DATA_DIR: custom },
    isWritable: () => true,
  });

  assert.equal(res.mode, 'override');
  assert.equal(res.dataDir, custom);
});

test('paths: resolveDataDir prefers portable-data when packaged and writable', () => {
  const exe = 'D:\\Portable\\BARQ\\barq.exe';
  const expectedPortable = path.resolve('D:\\Portable\\BARQ\\portable-data');
  const res = resolveDataDir({
    isPackaged: true,
    execPath: exe,
    appRoot: 'D:\\Portable\\BARQ',
    fallbackBase: 'C:\\Users\\User\\AppData\\Local',
    env: {},
    isWritable: (dir) => dir === expectedPortable,
  });

  assert.equal(res.mode, 'portable');
  assert.equal(res.dataDir, expectedPortable);
});

test('paths: resolveDataDir falls back to per-user when packaged but portable-data not writable', () => {
  const exe = 'C:\\Program Files\\BARQ\\barq.exe';
  const expectedFallback = path.resolve('C:\\Users\\User\\AppData\\Local\\BARQ Downloader');
  const res = resolveDataDir({
    isPackaged: true,
    execPath: exe,
    appRoot: 'C:\\Program Files\\BARQ',
    fallbackBase: 'C:\\Users\\User\\AppData\\Local',
    env: {},
    isWritable: (dir) => dir.startsWith('C:\\Users'),
  });

  assert.equal(res.mode, 'per-user');
  assert.equal(res.dataDir, expectedFallback);
});

test('paths: buildDataLayout creates required directories', () => {
  const tmp = path.join(__dirname, '..', 'test-data', `layout-${Date.now()}`);
  try {
    const layout = buildDataLayout(tmp);
    assert.equal(fs.existsSync(layout.dataDir), true);
    assert.equal(fs.existsSync(layout.logsDir), true);
    assert.equal(fs.existsSync(layout.tempDir), true);
    assert.equal(fs.existsSync(layout.backupsDir), true);
    assert.equal(fs.existsSync(layout.electronDir), true);
    assert.equal(layout.dbPath.endsWith('barq.db'), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
