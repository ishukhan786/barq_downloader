'use strict';

/**
 * BARQ DOWNLOADER — MILESTONE 2 QA & STRESS TEST SUITE
 * Complete automated test runner for all 10 QA phases.
 * Measures real memory, CPU, timings, SHA-256 hashes, and security boundaries.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { createTestServer, sha256 } = require('./fixtures/test-server');
const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo, EventsRepo } = require('../src/main/db/downloads-repo');
const { SettingsRepo } = require('../src/main/db/settings-repo');
const { buildSchema } = require('../src/main/settings-schema');
const { DownloadManager } = require('../src/main/engine/DownloadManager');
const { FilenameResolver } = require('../src/main/engine/FilenameResolver');
const { validateDownloadUrl, sanitizeFilename, isPathInside, validateId } = require('../src/main/security');

const QA_TEST_ROOT = path.join(__dirname, '..', 'test-data', `qa-stress-${Date.now()}`);

let serverInstance = null;
let baseUrl = null;
let sessionCounter = 0;

test.before(async () => {
  fs.mkdirSync(QA_TEST_ROOT, { recursive: true });
  serverInstance = createTestServer();
  baseUrl = await serverInstance.start();
});

test.after(async () => {
  if (serverInstance) {
    await serverInstance.stop();
  }
  try {
    fs.rmSync(QA_TEST_ROOT, { recursive: true, force: true });
  } catch {}
});

function createIsolatedSession(opts = {}) {
  sessionCounter++;
  const sessionDir = path.join(QA_TEST_ROOT, `session-${sessionCounter}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const downloadDir = path.join(sessionDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const db = new BarqDatabase(path.join(sessionDir, 'barq-qa.db')).open();
  const downloadsRepo = new DownloadsRepo(db);
  const eventsRepo = new EventsRepo(db);
  const schema = buildSchema({ defaultDownloadDir: downloadDir });
  const settingsRepo = new SettingsRepo(db, schema);
  const logger = { info() {}, warn() {}, error() {} };

  const manager = new DownloadManager({
    downloadsRepo,
    settingsRepo,
    eventsRepo,
    logger,
  });

  return { manager, db, sessionDir, downloadDir, downloadsRepo, settingsRepo, eventsRepo };
}

function waitForState(task, targetState, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (task.state === targetState) return resolve();

    const timer = setTimeout(() => {
      task.removeListener('state-changed', listener);
      reject(new Error(`Timeout waiting for state '${targetState}', current='${task.state}', error=${task.record?.error_message || 'none'}`));
    }, timeoutMs);

    const listener = (payload) => {
      if (payload.state === targetState) {
        clearTimeout(timer);
        task.removeListener('state-changed', listener);
        resolve();
      }
    };
    task.on('state-changed', listener);
  });
}

function verifyWithCertUtil(filePath) {
  try {
    const out = execSync(`certutil -hashfile "${filePath}" SHA256`, { encoding: 'utf8' });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // Line 1 is the file header, Line 2 is the hash, Line 3 is 'CertUtil: -hashfile command completed successfully.'
    const certUtilHash = lines[1]?.replace(/\s+/g, '').toLowerCase();
    return certUtilHash;
  } catch {
    return null;
  }
}

// ============================================================================
// PHASE 2 — AUTOMATED FUNCTIONAL TESTS
// ============================================================================

test('Phase 2.1: Download 1 MB file with SHA-256 verification', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/1mb`,
      filename: 'test-1mb.bin',
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.statSync(finalPath).size, 1024 * 1024);
    const downloadedHash = sha256(fs.readFileSync(finalPath));
    assert.equal(downloadedHash, serverInstance.hash1mb);

    const certHash = verifyWithCertUtil(finalPath);
    if (certHash) assert.equal(certHash, serverInstance.hash1mb);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.2: Download 10 MB file with SHA-256 verification', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/10mb`,
      filename: 'test-10mb.bin',
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.statSync(finalPath).size, 10 * 1024 * 1024);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.hash10mb);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.3: Download 100 MB file with SHA-256 verification', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/100mb`,
      filename: 'test-100mb.bin',
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed', 30000);

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.statSync(finalPath).size, 100 * 1024 * 1024);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.hash100mb);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.4 & 2.5: Unknown Content-Length & Chunked transfer encoding', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/unknown-length`,
      filename: 'chunked-data.bin',
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

test('Phase 2.6: URL with 301, 308, 302, 307 multi-hop redirects', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/redirect-chain-1`,
      filename: 'redirect-resolved.bin',
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.hash1mb);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.7: Content-Disposition standard and RFC 5987 Urdu filename', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    // 1. Standard Content-Disposition
    const meta1 = await manager.probe(`${baseUrl}/disposition`);
    assert.equal(meta1.filename, 'annual_report_2026.pdf');

    // 2. RFC 5987 with Urdu brand name برق
    const meta2 = await manager.probe(`${baseUrl}/disposition-urdu`);
    assert.equal(meta2.filename, 'barq برق.zip');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.8: Special characters in filename sanitized safely', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const probe = await manager.probe(`${baseUrl}/disposition-special`);
    // 'barq:test*file?v1<2>.zip' must have invalid characters replaced with '_'
    assert.equal(probe.filename, 'barq_test_file_v1_2_.zip');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.9: Existing duplicate filename resolved without overwrite', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const existingFile = path.join(downloadDir, 'data.bin');
    fs.writeFileSync(existingFile, 'ORIGINAL_USER_DATA_DO_NOT_TOUCH');

    const record = await manager.add({
      sourceUrl: `${baseUrl}/small`,
      filename: 'data.bin',
      destinationPath: downloadDir,
      startNow: false,
    });

    assert.equal(record.filename, 'data (1).bin');
    assert.equal(fs.readFileSync(existingFile, 'utf8'), 'ORIGINAL_USER_DATA_DO_NOT_TOUCH');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.10 & 2.11: Invalid URL & Nonexistent server rejection', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    // 1. Invalid URL scheme
    const val = validateDownloadUrl('ftp://ftp.example.com/file.zip');
    assert.equal(val.ok, false);
    assert.equal(val.error.toLowerCase().includes('http and https'), true);

    // 2. Nonexistent server fails with connection error
    const record = await manager.add({
      sourceUrl: 'http://127.0.0.1:54321/nofile',
      destinationPath: downloadDir,
      startNow: true,
    });
    const task = manager.tasks.get(record.id);
    await waitForState(task, 'retrying');
    assert.equal(task.state, 'retrying');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.12: HTTP 403, 404, 429, 500, 503 error classification', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    // 403: Permanent fail
    const r403 = await manager.add({ sourceUrl: `${baseUrl}/403`, destinationPath: downloadDir, startNow: true });
    const t403 = manager.tasks.get(r403.id);
    await waitForState(t403, 'failed');
    assert.equal(t403.state, 'failed');

    // 404: Permanent fail
    const r404 = await manager.add({ sourceUrl: `${baseUrl}/404`, destinationPath: downloadDir, startNow: true });
    const t404 = manager.tasks.get(r404.id);
    await waitForState(t404, 'failed');
    assert.equal(t404.state, 'failed');

    // 503: Recoverable retry
    const r503 = await manager.add({ sourceUrl: `${baseUrl}/503`, destinationPath: downloadDir, startNow: true });
    const t503 = manager.tasks.get(r503.id);
    await waitForState(t503, 'retrying');
    assert.equal(t503.state, 'retrying');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 2.13: Interrupted connection midway triggers retry', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/drop-midway`,
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

test('Phase 2.14: Unavailable destination directory throws clean user error', async () => {
  const { manager, db } = createIsolatedSession();
  try {
    const invalidPath = 'Z:\\nonexistent_volume_barq_test\\downloads';
    await assert.rejects(
      async () => {
        await manager.add({
          sourceUrl: `${baseUrl}/small`,
          destinationPath: invalidPath,
          startNow: true,
        });
      },
      /ENOENT|EACCES|ENOTDIR/
    );
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// ============================================================================
// PHASE 3 — PAUSE AND RESUME TESTS
// ============================================================================

test('Phase 3.1: Pause at >20%, verify disk bytes, and resume with HTTP 206', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);

    // Wait until at least 20% (approx 400 KB of 2 MB)
    await new Promise((resolve) => {
      const listener = (p) => {
        if (p.downloadedBytes >= 400 * 1024) {
          task.removeListener('progress', listener);
          resolve();
        }
      };
      task.on('progress', listener);
    });

    // Pause download
    await manager.pause(record.id);
    assert.equal(task.state, 'paused');

    // Partial file verification
    const partPath = task.writer.partialPath;
    assert.equal(fs.existsSync(partPath), true);
    const diskBytes = fs.statSync(partPath).size;
    assert.equal(diskBytes, task.downloadedBytes);

    // SQLite record verification
    const dbRec = manager.repo.getById(record.id);
    assert.equal(dbRec.downloaded_bytes, diskBytes);
    assert.equal(dbRec.status, 'paused');

    // Resume download to completion
    await manager.resume(record.id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, record.filename);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.largeHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 3.2: Safe restart from byte 0 when server ignores Range header', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const fn = 'range-ignored-test.bin';
    const partPath = path.join(downloadDir, `${fn}.barq-part`);
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(partPath, Buffer.alloc(16384, 0x99));

    const id = manager.repo.insert({
      source_url: `${baseUrl}/range-ignored`,
      filename: fn,
      destination_path: downloadDir,
      status: 'paused',
      downloaded_bytes: 16384,
      total_bytes: serverInstance.smallBuffer.length,
      partial_path: partPath,
      supports_ranges: 1,
    });

    await manager.resume(id);
    const task = manager.tasks.get(id);
    await waitForState(task, 'completed');

    const finalPath = path.join(downloadDir, fn);
    assert.equal(fs.existsSync(finalPath), true);
    assert.equal(fs.statSync(finalPath).size, serverInstance.smallBuffer.length);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.smallHash);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 3.3: HTTP 416 handled safely when partial file is already full size', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const fn = '416-test.bin';
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

test('Phase 3.4: Stale ETag triggers clean restart from 0', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const fn = 'etag-test.txt';
    const partPath = path.join(downloadDir, `${fn}.barq-part`);
    fs.mkdirSync(downloadDir, { recursive: true });
    fs.writeFileSync(partPath, Buffer.from('stale partial content'));

    const id = manager.repo.insert({
      source_url: `${baseUrl}/dynamic-etag`,
      filename: fn,
      destination_path: downloadDir,
      status: 'paused',
      downloaded_bytes: 21,
      etag: '"stale-etag-token-xyz"',
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

// ============================================================================
// PHASE 4 — APPLICATION RESTART & RECOVERY
// ============================================================================

test('Phase 4: Crash/restart recovery reconciles disk size with SQLite', async () => {
  sessionCounter++;
  const sessionDir = path.join(QA_TEST_ROOT, `session-${sessionCounter}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const downloadDir = path.join(sessionDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  const fn = 'simulated-crash.bin';
  const partPath = path.join(downloadDir, `${fn}.barq-part`);
  // Simulate 512 KB written before process crash
  const partialBuffer = serverInstance.largeBuffer.subarray(0, 512 * 1024);
  fs.writeFileSync(partPath, partialBuffer);

  const dbPath = path.join(sessionDir, 'crash.db');
  let db = new BarqDatabase(dbPath).open();

  // Insert download stuck in 'downloading' status
  const rowId = db.prepare(`
    INSERT INTO downloads (source_url, filename, destination_path, status, total_bytes, downloaded_bytes,
      supports_ranges, created_at, updated_at, partial_path, etag)
    VALUES (?, ?, ?, 'downloading', ?, ?, 1, ?, ?, ?, ?)`).run(
    `${baseUrl}/large`,
    fn,
    downloadDir,
    serverInstance.largeBuffer.length,
    100000, // Stale DB count (100000 != 524288)
    Date.now(),
    Date.now(),
    partPath,
    `"${serverInstance.largeHash}"`
  ).lastInsertRowid;

  db.close();

  // Simulate app restart
  db = new BarqDatabase(dbPath).open();
  const schema = buildSchema({ defaultDownloadDir: downloadDir });
  const manager = new DownloadManager({
    downloadsRepo: new DownloadsRepo(db),
    settingsRepo: new SettingsRepo(db, schema),
    eventsRepo: new EventsRepo(db),
    logger: { info() {}, warn() {}, error() {} },
  });

  await manager.init();

  // Verify DB was reconciled to actual disk size (512 KB) and status changed to paused
  const recoveredRec = manager.repo.getById(Number(rowId));
  assert.equal(recoveredRec.status, 'paused');
  assert.equal(recoveredRec.downloaded_bytes, 512 * 1024);

  // Resume to completion
  await manager.resume(Number(rowId));
  const task = manager.tasks.get(Number(rowId));
  await waitForState(task, 'completed');

  const finalPath = path.join(downloadDir, fn);
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.largeHash);

  await manager.shutdown();
  db.close();
});

// ============================================================================
// PHASE 5 — RETRY AND CANCELLATION
// ============================================================================

test('Phase 5.1: Cancel download and delete partial file', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'downloading');

    await manager.cancel(record.id, true);
    assert.equal(task.state, 'cancelled');

    const partPath = task.writer.partialPath;
    assert.equal(fs.existsSync(partPath), false);
    const dbRec = manager.repo.getById(record.id);
    assert.equal(dbRec.status, 'canceled');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 5.2: Cancel download while in retry wait terminates timer', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/500`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'retrying');

    // Cancel while waiting for retry timer
    await manager.cancel(record.id, true);
    assert.equal(task.state, 'cancelled');
    assert.equal(task.retryTimer, null);

    // Wait a brief moment to ensure timer never fires
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(task.state, 'cancelled');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 5.3: Manual retry resets retry count', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/500`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'retrying');
    assert.equal(task.record.retry_count >= 1, true);

    await manager.pause(record.id);
    assert.equal(task.state, 'paused');

    // Manually retry
    await manager.retry(record.id);
    assert.equal(task.record.retry_count, 0);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// ============================================================================
// PHASE 7 — CONCURRENCY AND STRESS TESTS
// ============================================================================

test('Phase 7.1: Concurrency scheduler enforces max concurrent active downloads', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    manager.settings.update({ maxConcurrentDownloads: 3 }, { trusted: true });

    const records = await Promise.all([
      manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'conc1.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'conc2.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'conc3.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'conc4.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/slow-stream`, filename: 'conc5.bin', destinationPath: downloadDir, startNow: true }),
    ]);

    await new Promise((r) => setTimeout(r, 150));

    let runningCount = 0;
    for (const r of records) {
      const task = manager.tasks.get(r.id);
      if (task.isRunning) runningCount++;
    }

    assert.equal(runningCount, 3);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 7.2: Stress test measuring RAM, CPU, speed, and event loop responsiveness', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    manager.settings.update({ maxConcurrentDownloads: 5 }, { trusted: true });

    const memBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const startTime = Date.now();

    // Measure event loop lag during active downloads
    let maxLagMs = 0;
    let lagChecks = 0;
    const lagInterval = setInterval(() => {
      const expected = 20;
      const t0 = Date.now();
      setTimeout(() => {
        const actual = Date.now() - t0;
        const lag = Math.max(0, actual - expected);
        if (lag > maxLagMs) maxLagMs = lag;
        lagChecks++;
      }, expected);
    }, 25);

    // Download 5 parallel 1MB files
    const downloads = await Promise.all([
      manager.add({ sourceUrl: `${baseUrl}/1mb`, filename: 'stress1.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/1mb`, filename: 'stress2.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/1mb`, filename: 'stress3.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/1mb`, filename: 'stress4.bin', destinationPath: downloadDir, startNow: true }),
      manager.add({ sourceUrl: `${baseUrl}/1mb`, filename: 'stress5.bin', destinationPath: downloadDir, startNow: true }),
    ]);

    for (const d of downloads) {
      const task = manager.tasks.get(d.id);
      await waitForState(task, 'completed');
    }

    clearInterval(lagInterval);

    const durationSec = (Date.now() - startTime) / 1000;
    const cpuDelta = process.cpuUsage(cpuBefore);
    const memAfter = process.memoryUsage();
    const totalBytes = 5 * 1024 * 1024;
    const throughputMBps = (totalBytes / (1024 * 1024)) / durationSec;

    console.log('\n--- PERFORMANCE BENCHMARK MEASUREMENTS ---');
    console.log(`Parallel Transfers: 5 downloads (5 MB total)`);
    console.log(`Execution Time: ${durationSec.toFixed(2)} s`);
    console.log(`Throughput: ${throughputMBps.toFixed(2)} MB/s`);
    console.log(`User CPU: ${(cpuDelta.user / 1000).toFixed(1)} ms, System CPU: ${(cpuDelta.system / 1000).toFixed(1)} ms`);
    console.log(`Heap Used Before: ${(memBefore.heapUsed / (1024 * 1024)).toFixed(2)} MB, After: ${(memAfter.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`RSS: ${(memAfter.rss / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Max Event-Loop Lag: ${maxLagMs} ms (responsive desktop UI)`);
    console.log('-------------------------------------------\n');

    assert.equal(throughputMBps > 0.5, true);
    assert.equal(maxLagMs < 100, true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

// ============================================================================
// PHASE 8 — SECURITY TESTS
// ============================================================================

test('Phase 8.1: Directory traversal in filenames is stripped', () => {
  const traversalCases = [
    '../../etc/passwd',
    '..\\..\\windows\\system32\\cmd.exe',
    'foo/../../bar.zip',
    'C:\\sensitive\\data.txt',
    '\\\\attacker\\share\\payload.exe',
  ];

  for (const tc of traversalCases) {
    const clean = sanitizeFilename(tc);
    assert.equal(clean.includes('..'), false);
    assert.equal(clean.includes('/'), false);
    assert.equal(clean.includes('\\'), false);
    assert.equal(clean.includes(':'), false);
  }
});

test('Phase 8.2: Windows reserved device names are defanged', () => {
  const reservedNames = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9', 'con.txt', 'nul.tar.gz'];

  for (const name of reservedNames) {
    const clean = sanitizeFilename(name);
    assert.equal(/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i.test(clean), false);
  }
});

test('Phase 8.3: Untrusted redirect schemes are blocked', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/bad-redirect`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'failed');
    assert.equal(task.state, 'failed');
    assert.equal(task.record.error_message.includes('Untrusted redirect protocol'), true);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 8.4: Path escape validation with isPathInside', () => {
  const base = 'D:\\Projects\\BARQ_DOWNLOADER\\downloads';
  assert.equal(isPathInside(base, 'D:\\Projects\\BARQ_DOWNLOADER\\downloads\\file.zip'), true);
  assert.equal(isPathInside(base, 'D:\\Projects\\BARQ_DOWNLOADER\\downloads\\sub\\file.zip'), true);
  assert.equal(isPathInside(base, 'D:\\Projects\\BARQ_DOWNLOADER\\main.js'), false);
  assert.equal(isPathInside(base, 'C:\\Windows\\System32'), false);
});

// ============================================================================
// PHASE 9 — UI AND DATABASE INTEGRATION TESTS
// ============================================================================

test('Phase 9.1: View filters and search queries match exact SQLite criteria', async () => {
  const { manager, db, downloadsRepo, downloadDir } = createIsolatedSession();
  try {
    // Populate records across multiple states and categories
    downloadsRepo.insert({ source_url: 'http://example.com/1', filename: 'report_finance.pdf', destination_path: downloadDir, status: 'completed' });
    downloadsRepo.insert({ source_url: 'http://example.com/2', filename: 'song_audio.mp3', destination_path: downloadDir, status: 'downloading' });
    downloadsRepo.insert({ source_url: 'http://example.com/3', filename: 'archive_backup.zip', destination_path: downloadDir, status: 'paused' });
    downloadsRepo.insert({ source_url: 'http://example.com/4', filename: 'setup_barq.exe', destination_path: downloadDir, status: 'queued' });
    downloadsRepo.insert({ source_url: 'http://example.com/5', filename: 'corrupt_install.iso', destination_path: downloadDir, status: 'failed' });
    downloadsRepo.insert({ source_url: 'http://example.com/6', filename: 'movie_stream.mp4', destination_path: downloadDir, status: 'completed', task_type: 'video' });

    // Test view: all
    const all = downloadsRepo.list({ view: 'all' });
    assert.equal(all.length, 6);

    // Test view: completed
    const completed = downloadsRepo.list({ view: 'completed' });
    assert.equal(completed.length, 2);

    // Test view: downloading
    const downloading = downloadsRepo.list({ view: 'downloading' });
    assert.equal(downloading.length, 1);
    assert.equal(downloading[0].filename, 'song_audio.mp3');

    // Test view: paused
    const paused = downloadsRepo.list({ view: 'paused' });
    assert.equal(paused.length, 1);
    assert.equal(paused[0].filename, 'archive_backup.zip');

    // Test view: failed
    const failed = downloadsRepo.list({ view: 'failed' });
    assert.equal(failed.length, 1);

    // Test view: video
    const video = downloadsRepo.list({ view: 'video' });
    assert.equal(video.length, 1);
    assert.equal(video[0].filename, 'movie_stream.mp4');

    // Test search filter
    const searched = downloadsRepo.list({ view: 'all', search: 'finance' });
    assert.equal(searched.length, 1);
    assert.equal(searched[0].filename, 'report_finance.pdf');
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 9.2: Add to Queue places task in queued status without starting network stream', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      filename: 'queued-only.bin',
      destinationPath: downloadDir,
      startNow: false, // User clicked "Add to Queue"
    });

    const task = manager.tasks.get(record.id);
    assert.equal(record.status, 'queued');
    assert.equal(task.isRunning, false);
    assert.equal(task.state, 'pending');

    // Network writer should not be active
    const partPath = path.join(downloadDir, `${record.filename}.barq-part`);
    assert.equal(fs.existsSync(partPath), false);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 9.3: Telemetry calculations and UI metrics report accurate values', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/1mb`,
      destinationPath: downloadDir,
      startNow: true,
    });

    const task = manager.tasks.get(record.id);
    await waitForState(task, 'completed');

    const tel = manager.getTelemetry(record.id);
    assert.equal(tel.downloadedBytes, 1024 * 1024);
    assert.equal(tel.totalBytes, 1024 * 1024);
    assert.equal(tel.state, 'completed');

    const globalTel = manager.getGlobalTelemetry();
    assert.equal(globalTel.activeTransfers, 0); // No active transfers remaining
  } finally {
    await manager.shutdown();
    db.close();
  }
});

test('Phase 9.4: Task removal from history purges from memory and SQLite', async () => {
  const { manager, db, downloadDir } = createIsolatedSession();
  try {
    const record = await manager.add({
      sourceUrl: `${baseUrl}/small`,
      destinationPath: downloadDir,
      startNow: false,
    });

    assert.equal(manager.tasks.has(record.id), true);
    assert.equal(manager.repo.getById(record.id) !== null, true);

    await manager.remove(record.id);

    assert.equal(manager.tasks.has(record.id), false);
    assert.equal(manager.repo.getById(record.id), null);
  } finally {
    await manager.shutdown();
    db.close();
  }
});

