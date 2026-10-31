'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTestServer, sha256 } = require('./fixtures/test-server');
const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo, EventsRepo } = require('../src/main/db/downloads-repo');
const { SettingsRepo } = require('../src/main/db/settings-repo');
const { buildSchema } = require('../src/main/settings-schema');
const { DownloadManager } = require('../src/main/engine/DownloadManager');
const { FilenameResolver } = require('../src/main/engine/FilenameResolver');

const TEST_ROOT = path.join(__dirname, '..', 'test-data', `engine-test-${Date.now()}`);

let serverInstance = null;
let baseUrl = null;
let testDirCounter = 0;

test.before(async () => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  serverInstance = createTestServer();
  baseUrl = await serverInstance.start();
});

test.after(async () => {
  if (serverInstance) {
    await serverInstance.stop();
  }
  try {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

function createIsolatedManager() {
  testDirCounter++;
  const dir = path.join(TEST_ROOT, `session-${testDirCounter}`);
  fs.mkdirSync(dir, { recursive: true });

  const db = new BarqDatabase(path.join(dir, 'test.db')).open();
  const downloadsRepo = new DownloadsRepo(db);
  const eventsRepo = new EventsRepo(db);
  const schema = buildSchema({ defaultDownloadDir: path.join(dir, 'downloads') });
  const settingsRepo = new SettingsRepo(db, schema);
  const logger = { info() {}, warn() {}, error() {} };

  const manager = new DownloadManager({
    downloadsRepo,
    settingsRepo,
    eventsRepo,
    logger,
  });

  return {
    manager,
    db,
    dir,
    downloadDir: path.join(dir, 'downloads'),
  };
}

function waitForState(task, targetState, timeoutMs = 8000) {
  if (task.state === targetState) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer = null;
    const listener = (s) => {
      if (s.state === targetState) {
        if (timer) clearTimeout(timer);
        task.removeListener('state-changed', listener);
        resolve();
      }
    };
    task.on('state-changed', listener);
    if (task.state === targetState) {
      if (timer) clearTimeout(timer);
      task.removeListener('state-changed', listener);
      resolve();
      return;
    }
    timer = setTimeout(() => {
      task.removeListener('state-changed', listener);
      reject(new Error(`Timed out waiting for state "${targetState}" (current: "${task.state}")`));
    }, timeoutMs);
  });
}

// 1. Small file download + SHA-256 verification
test('engine 01: small file download and SHA-256 verification', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/small`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);

    const content = fs.readFileSync(finalPath);
    const hash = sha256(content);
    assert.equal(hash, serverInstance.smallHash);
    assert.equal(content.length, serverInstance.smallBuffer.length);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 2. Large file download + SHA-256 verification
test('engine 02: large file download (2 MB) and SHA-256 verification', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/large`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);

    const content = fs.readFileSync(finalPath);
    const hash = sha256(content);
    assert.equal(hash, serverInstance.largeHash);
    assert.equal(content.length, serverInstance.largeBuffer.length);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 3. Unknown Content-Length download
test('engine 03: handles unknown Content-Length (chunked transfer)', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/unknown-length`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.statSync(finalPath).size, serverInstance.smallBuffer.length);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 4. Content-Disposition filename parsing
test('engine 04: resolves filename from Content-Disposition header', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/disposition`,
      destinationPath: downloadDir,
      startNow: true,
    });

    assert.equal(record.filename, 'annual_report_2026.pdf');
    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, 'annual_report_2026.pdf');
    assert.equal(fs.existsSync(finalPath), true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 5. Redirect chain handling
test('engine 05: follows 302 and 307 redirect chain successfully', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/redirect-1`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.smallHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 6. HTTP 404 Not Found error handling
test('engine 06: handles HTTP 404 and transitions to failed state', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/404`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'failed');

    assert.equal(task.state, 'failed');
    const dbRec = manager.repo.getById(record.id);
    assert.equal(dbRec.status, 'failed');
    assert.equal(dbRec.error_code, 'HTTP_404');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 7. HTTP 403 Forbidden handling
test('engine 07: handles HTTP 403 without retrying non-recoverable error', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/403`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'failed');

    assert.equal(task.state, 'failed');
    const dbRec = manager.repo.getById(record.id);
    assert.equal(dbRec.error_code, 'HTTP_403');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 8. HTTP 429 Rate limiting and retry with Retry-After
test('engine 08: handles HTTP 429 rate limit with Retry-After backoff', async () => {
  serverInstance.resetRetries();
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/429-retry`,
      filename: 'retry-429.bin',
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed', 10000);

    assert.equal(task.state, 'completed');
    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 9. HTTP 500 Internal Server Error retry
test('engine 09: handles HTTP 500 with automatic retry policy', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/500`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'retrying');

    assert.equal(task.state, 'retrying');
    assert.equal(task.record.retry_count >= 1, true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 10. Pause during download and resume to completion
test('engine 10, 11, 12: pause during slow download and safely resume', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);

    // Wait until at least 64 KB is downloaded
    await new Promise((resolve) => {
      const listener = (p) => {
        if (p.downloadedBytes >= 64 * 1024) {
          task.removeListener('progress', listener);
          resolve();
        }
      };
      task.on('progress', listener);
    });

    // Pause download
    await manager.pause(record.id);
    assert.equal(task.state, 'paused');

    // Verify partial file on disk matches reported downloaded bytes
    const partPath = task.writer.partialPath;
    assert.equal(fs.existsSync(partPath), true);
    const diskBytes = fs.statSync(partPath).size;
    assert.equal(diskBytes, task.downloadedBytes);

    // Resume download
    await manager.resume(record.id);
    await waitForState(task, 'completed');

    assert.equal(task.state, 'completed');
    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.largeHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 13. Resume after application restart & crash recovery
test('engine 13 & 28: recovers interrupted downloads upon restart and resumes', async () => {
  testDirCounter++;
  const dir = path.join(TEST_ROOT, `session-${testDirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  const downloadDir = path.join(dir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const dbPath = path.join(dir, 'restart.db');
  let db = new BarqDatabase(dbPath).open();
  let repo = new DownloadsRepo(db);
  let schema = buildSchema({ defaultDownloadDir: downloadDir });
  let settings = new SettingsRepo(db, schema);
  let events = new EventsRepo(db);
  let logger = { info() {}, warn() {}, error() {} };

  // Write a simulated interrupted partial file on disk (128 KB)
  const partName = 'resume-test.bin.barq-part';
  const partPath = path.join(downloadDir, partName);
  fs.writeFileSync(partPath, serverInstance.largeBuffer.subarray(0, 128 * 1024));

  // Insert download in 'downloading' state as if the process crashed
  const id = repo.insert({
    source_url: `${baseUrl}/large`,
    filename: 'resume-test.bin',
    destination_path: downloadDir,
    status: 'downloading',
    total_bytes: serverInstance.largeBuffer.length,
    downloaded_bytes: 64 * 1024, // old inaccurate progress
    partial_path: partPath,
    supports_ranges: 1,
  });

  db.close(); // simulate app exit

  // Start fresh application session
  db = new BarqDatabase(dbPath).open();
  repo = new DownloadsRepo(db);
  settings = new SettingsRepo(db, schema);
  events = new EventsRepo(db);

  const manager = new DownloadManager({
    downloadsRepo: repo,
    settingsRepo: settings,
    eventsRepo: events,
    logger,
  });

  try {
    await manager.init();

    // Verify recovery reconciled database progress with actual disk file
    const recoveredRec = repo.getById(id);
    assert.equal(recoveredRec.status, 'paused');
    assert.equal(recoveredRec.downloaded_bytes, 128 * 1024);

    // User resumes recovered download
    await manager.resume(id);
    const task = manager.tasks.get(id);

    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, 'resume-test.bin');
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.largeHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 14 & 15. Server ignores Range header (restarts safely from 0 without corrupting)
test('engine 15: safely restarts from byte 0 when server ignores Range header', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const fn = 'ignore-range.bin';
    const partPath = path.join(downloadDir, `${fn}.barq-part`);
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(partPath, Buffer.from('OLD STALE DATA THAT MUST NOT BE APPENDED TO'));

    const id = manager.repo.insert({
      source_url: `${baseUrl}/range-ignored`,
      filename: fn,
      destination_path: downloadDir,
      status: 'paused',
      downloaded_bytes: 40,
      partial_path: partPath,
      supports_ranges: 1,
    });

    await manager.resume(id);
    const task = manager.tasks.get(id);

    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, fn);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.smallHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 16. Invalid Content-Range header handling
test('engine 16: handles invalid Content-Range header safely', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const fn = 'invalid-range.bin';
    const partPath = path.join(downloadDir, `${fn}.barq-part`);
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(partPath, Buffer.from('PARTIAL'));

    const id = manager.repo.insert({
      source_url: `${baseUrl}/invalid-range`,
      filename: fn,
      destination_path: downloadDir,
      status: 'paused',
      downloaded_bytes: 7,
      partial_path: partPath,
      supports_ranges: 1,
    });

    await manager.resume(id);
    const task = manager.tasks.get(id);

    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, fn);
    assert.equal(fs.existsSync(finalPath), true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 17. HTTP 416 Range Not Satisfiable handling
test('engine 17: handles HTTP 416 when partial file is already full size', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const fn = 'already-done.bin';
    const partPath = path.join(downloadDir, `${fn}.barq-part`);
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(partPath, serverInstance.smallBuffer);

    const id = manager.repo.insert({
      source_url: `${baseUrl}/416`,
      filename: fn,
      destination_path: downloadDir,
      status: 'paused',
      downloaded_bytes: serverInstance.smallBuffer.length,
      total_bytes: serverInstance.smallBuffer.length,
      partial_path: partPath,
      supports_ranges: 1,
    });

    await manager.resume(id);
    const task = manager.tasks.get(id);

    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, fn);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.smallHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 18. Changed ETag detection
test('engine 18: detects changed ETag on server and resets download from 0', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const fn = 'etag-test.txt';
    const partPath = path.join(downloadDir, `${fn}.barq-part`);
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(partPath, Buffer.from('old content'));

    const id = manager.repo.insert({
      source_url: `${baseUrl}/dynamic-etag`,
      filename: fn,
      destination_path: downloadDir,
      status: 'paused',
      downloaded_bytes: 11,
      etag: '"stale-etag-999"',
      partial_path: partPath,
      supports_ranges: 1,
    });

    await manager.resume(id);
    const task = manager.tasks.get(id);

    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, fn);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.readFileSync(finalPath, 'utf8').startsWith('Resource Version'), true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 19. Cancellation with keep vs delete partial data
test('engine 19: cancel download with deletePartial removes .barq-part file', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'downloading');

    // Cancel with deletePartial: true
    await manager.cancel(record.id, true);
    assert.equal(task.state, 'cancelled');

    // Partial file should be removed
    const partPath = task.writer.partialPath;
    assert.equal(fs.existsSync(partPath), false);
    const dbRec = manager.repo.getById(record.id);
    assert.equal(dbRec.status, 'canceled');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 21 & 22. Collision and duplicate filename resolution
test('engine 21 & 22: prevents duplicate overwrites with collision suffixes', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    fs.mkdirSync(downloadDir, { recursive: true });
    // Existing file in destination
    fs.writeFileSync(path.join(downloadDir, 'package.zip'), 'EXISTING_FILE_DO_NOT_OVERWRITE');

    const record = await manager.add({
      sourceUrl: `${baseUrl}/small`,
      filename: 'package.zip',
      destinationPath: downloadDir,
      startNow: false,
    });

    // Filename should automatically be 'package (1).zip'
    assert.equal(record.filename, 'package (1).zip');
    assert.equal(fs.readFileSync(path.join(downloadDir, 'package.zip'), 'utf8'), 'EXISTING_FILE_DO_NOT_OVERWRITE');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 26. Concurrency queue ordering
test('engine 26: enforces maxConcurrentDownloads limit across queue', async () => {
  const { manager, db, downloadDir } = createIsolatedManager();
  try {
    manager.settings.update({ maxConcurrentDownloads: 2 }, { trusted: true });

    const r1 = await manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'slow1.bin', destinationPath: downloadDir, startNow: true });
    const r2 = await manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'slow2.bin', destinationPath: downloadDir, startNow: true });
    const r3 = await manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'slow3.bin', destinationPath: downloadDir, startNow: true });

    const t1 = manager.tasks.get(r1.id);
    const t2 = manager.tasks.get(r2.id);
    const t3 = manager.tasks.get(r3.id);

    // Wait briefly for scheduler to assign
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(t1.isRunning, true);
    assert.equal(t2.isRunning, true);
    // Task 3 must wait in queued/pending state due to maxConcurrent = 2
    assert.equal(t3.isRunning, false);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// 27. Probe metadata resolution
test('engine 27: probe resolves metadata without downloading body', async () => {
  const probe = FilenameResolver.parseContentDisposition('attachment; filename="test_file.iso"');
  assert.equal(probe, 'test_file.iso');

  const { manager, db } = createIsolatedManager();
  try {
    const meta = await manager.probe(`${baseUrl}/disposition-rfc5987`);
    assert.equal(meta.filename, 'barq data (1).bin');
    assert.equal(meta.totalBytes, serverInstance.smallBuffer.length);
  } finally {
    await manager.shutdown();
    db.close();
  }
});
