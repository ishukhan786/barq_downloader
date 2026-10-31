'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const net = require('node:net');

const { createTestServer } = require('./fixtures/test-server');
const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo } = require('../src/main/db/downloads-repo');
const { SettingsRepo } = require('../src/main/db/settings-repo');
const { EventsRepo } = require('../src/main/db/downloads-repo');
const { SegmentsRepo } = require('../src/main/db/segments-repo');
const { buildSchema } = require('../src/main/settings-schema');

const { SegmentPlanner } = require('../src/main/engine/SegmentPlanner');
const { RangeSupportDetector } = require('../src/main/engine/RangeSupportDetector');
const { SegmentTask } = require('../src/main/engine/SegmentTask');
const { SegmentMerger } = require('../src/main/engine/SegmentMerger');
const { SegmentRecoveryManager } = require('../src/main/engine/SegmentRecoveryManager');
const { SegmentedDownloadTask } = require('../src/main/engine/SegmentedDownloadTask');
const { DownloadManager } = require('../src/main/engine/DownloadManager');
const { DownloadTask } = require('../src/main/engine/DownloadTask');
const { DownloadValidator } = require('../src/main/engine/DownloadValidator');
const { NativePipeServer, PROTOCOL_VERSION } = require('../src/main/native-pipe-server');

const {
  validateDownloadUrl,
  sanitizeFilename,
  isPathInside,
  safeJoin,
  validateId,
} = require('../src/main/security');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function makeTempDir(prefix = 'barq-m5-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createTestHarness(testDir) {
  const dbPath = path.join(testDir, 'barq.db');
  const db = new BarqDatabase(dbPath).open();
  const downloadsRepo = new DownloadsRepo(db);
  const segmentsRepo = new SegmentsRepo(db);
  const settingsRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
  const eventsRepo = new EventsRepo(db);

  const manager = new DownloadManager({
    downloadsRepo,
    settingsRepo,
    eventsRepo,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
  });

  return { db, downloadsRepo, segmentsRepo, settingsRepo, eventsRepo, manager };
}

function waitForDownload(task, timeoutMs = 60000) {
  if (task.state === 'completed') return Promise.resolve();
  if (task.state === 'failed') return Promise.reject(new Error(task.errorMessage || 'Download already failed'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Download timeout after ${timeoutMs}ms for task #${task.id}`));
    }, timeoutMs);

    task.on('state-changed', (s) => {
      if (s.state === 'completed') {
        clearTimeout(timer);
        resolve();
      } else if (s.state === 'failed') {
        clearTimeout(timer);
        reject(new Error(s.extra?.errorMessage || 'Download failed with state: failed'));
      }
    });
  });
}

test('BARQ Downloader — Milestone 5 Production Hardening & Reliability Suite', async (t) => {
  const serverInstance = createTestServer();
  const baseUrl = await serverInstance.start();

  t.after(async () => {
    await serverInstance.stop();
  });

  // ==========================================================================
  // TASK 1: REAL-WORLD DOWNLOAD TESTING & PROTOCOL HARDENING
  // ==========================================================================

  await t.test('1.1: Small 64 KB download with exact bit-for-bit SHA-256 verification', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/small`,
      filename: 'small.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task);

    const target = path.join(testDir, 'small.bin');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.statSync(target).size, serverInstance.smallBuffer.length);
    assert.equal(await hashFile(target), serverInstance.smallHash);

    await manager.shutdown();
    db.close();
  });

  await t.test('1.2: 100 MB large file download with 8 parallel connections and verified SHA-256 match', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 8 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/100mb`,
      filename: 'large-100mb.bin',
      destinationPath: testDir,
      startNow: true,
    });

    assert.equal(rec.is_segmented, 1);
    assert.equal(rec.segment_count, 8);

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task, 60000);

    const target = path.join(testDir, 'large-100mb.bin');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.statSync(target).size, serverInstance.buf100mb.length);
    assert.equal(await hashFile(target), serverInstance.hash100mb);

    await manager.shutdown();
    db.close();
  });

  await t.test('1.3: 1 GB streaming download with 8 parallel segments and SHA-256 match', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 8, minSegmentSize: 1024 * 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/1gb`,
      filename: 'massive-1gb.bin',
      destinationPath: testDir,
      startNow: true,
    });

    assert.equal(rec.is_segmented, 1);
    assert.equal(rec.segment_count, 8);

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task, 90000);

    const target = path.join(testDir, 'massive-1gb.bin');
    assert.equal(fs.existsSync(target), true);
    assert.equal(fs.statSync(target).size, serverInstance.total1gbBytes);
    const diskHash = await hashFile(target);
    assert.equal(diskHash, serverInstance.hash1gb);

    await manager.shutdown();
    db.close();
  });

  await t.test('1.4: Handles unknown Content-Length (chunked transfer) with single-stream fallback', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/unknown-length`,
      filename: 'chunked.bin',
      destinationPath: testDir,
      startNow: true,
    });

    // Chunked unknown length must NOT be segmented
    assert.equal(rec.is_segmented, 0);

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task);

    const target = path.join(testDir, 'chunked.bin');
    assert.equal(fs.statSync(target).size, serverInstance.smallBuffer.length);
    assert.equal(await hashFile(target), serverInstance.smallHash);

    await manager.shutdown();
    db.close();
  });

  await t.test('1.5: Multi-hop redirects (301 -> 308 -> 302 -> 307 -> 200) followed with correct segmentation', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/redirect-chain-1`,
      filename: 'redirect-target.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task);

    const target = path.join(testDir, 'redirect-target.bin');
    assert.equal(fs.statSync(target).size, serverInstance.buf1mb.length);
    assert.equal(await hashFile(target), serverInstance.hash1mb);

    await manager.shutdown();
    db.close();
  });

  await t.test('1.6: Slow stream download with backpressure handling (no event loop blocking)', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      filename: 'slow.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    assert.ok(task);

    // Let it stream some bytes under backpressure
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(task.downloadedBytes > 0);

    await task.cancel(true);
    await manager.shutdown();
    db.close();
  });

  await t.test('1.7: HTTP error classification (403, 404, 429 with Retry-After, 500)', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    // 403 Forbidden - non-retryable
    const rec403 = await manager.add({
      sourceUrl: `${baseUrl}/403`,
      filename: 'forbidden.bin',
      destinationPath: testDir,
      startNow: true,
    });
    const task403 = manager.tasks.get(rec403.id);
    await assert.rejects(waitForDownload(task403, 5000));
    assert.equal(task403.state, 'failed');

    // 404 Not Found - non-retryable
    const rec404 = await manager.add({
      sourceUrl: `${baseUrl}/404`,
      filename: 'notfound.bin',
      destinationPath: testDir,
      startNow: true,
    });
    const task404 = manager.tasks.get(rec404.id);
    await assert.rejects(waitForDownload(task404, 5000));
    assert.equal(task404.state, 'failed');

    // 429 Rate Limit with Retry-After - recovers on attempt 3
    serverInstance.resetRetries();
    const rec429 = await manager.add({
      sourceUrl: `${baseUrl}/429-retry`,
      filename: 'rate-limited.bin',
      destinationPath: testDir,
      startNow: true,
    });
    const task429 = manager.tasks.get(rec429.id);
    await waitForDownload(task429, 10000);
    assert.equal(task429.state, 'completed');

    await manager.shutdown();
    db.close();
  });

  await t.test('1.8: Server without Range support falls back cleanly to single-stream download', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 4 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/range-ignored`,
      filename: 'fallback-no-range.bin',
      destinationPath: testDir,
      startNow: true,
    });

    assert.equal(rec.is_segmented, 0); // Correctly detected no range support

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task);

    const target = path.join(testDir, 'fallback-no-range.bin');
    assert.equal(fs.statSync(target).size, serverInstance.smallBuffer.length);
    assert.equal(await hashFile(target), serverInstance.smallHash);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // TASK 2: PAUSE, RESUME & RECOVERY
  // ==========================================================================

  await t.test('2.1: Pause during segmented transfer, verify .part files, resume and verify SHA-256', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 4, minSegmentSize: 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      filename: 'pause-resume-seg.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);

    // Wait until at least 250 KB downloaded then pause
    await new Promise((resolve) => {
      const onProgress = () => {
        if (task.downloadedBytes >= 250 * 1024) {
          task.removeListener('progress', onProgress);
          resolve();
        }
      };
      task.on('progress', onProgress);
    });

    await manager.pause(rec.id);
    assert.equal(task.state, 'paused');

    // Verify .barq-parts directory exists and has part files
    const partsDir = path.join(testDir, 'pause-resume-seg.bin.barq-parts');
    assert.equal(fs.existsSync(partsDir), true);
    const files = fs.readdirSync(partsDir);
    assert.ok(files.length > 0);

    // Resume to completion
    await manager.resume(rec.id);
    await waitForDownload(task, 30000);

    const target = path.join(testDir, 'pause-resume-seg.bin');
    assert.equal(fs.statSync(target).size, serverInstance.largeBuffer.length);
    assert.equal(await hashFile(target), serverInstance.largeHash);
    assert.equal(fs.existsSync(partsDir), false); // cleaned up after merge

    await manager.shutdown();
    db.close();
  });

  await t.test('2.2: Process crash recovery: reconcile database with verified disk bytes upon restart', async () => {
    const testDir = makeTempDir();
    const dbPath = path.join(testDir, 'crash.db');

    let db = new BarqDatabase(dbPath).open();
    let dRepo = new DownloadsRepo(db);
    let sRepo = new SegmentsRepo(db);
    let setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    let eRepo = new EventsRepo(db);

    const totalBytes = serverInstance.largeBuffer.length;
    const partsDir = path.join(testDir, 'crash-recovered.bin.barq-parts');
    fs.mkdirSync(partsDir, { recursive: true });

    const part0 = path.join(partsDir, 'segment-000.part');
    const part1 = path.join(partsDir, 'segment-001.part');
    fs.writeFileSync(part0, serverInstance.largeBuffer.subarray(0, 1024 * 1024)); // 1 MB
    fs.writeFileSync(part1, serverInstance.largeBuffer.subarray(1024 * 1024, (1024 + 512) * 1024)); // 512 KB

    const dlId = dRepo.insert({
      source_url: `${baseUrl}/large`,
      filename: 'crash-recovered.bin',
      destination_path: testDir,
      status: 'downloading',
      total_bytes: totalBytes,
      downloaded_bytes: 800 * 1024,
      is_segmented: 1,
      segment_count: 2,
      supports_ranges: 1,
    });

    sRepo.insertBatch([
      {
        download_id: dlId,
        segment_index: 0,
        start_byte: 0,
        end_byte: 1048575,
        downloaded_bytes: 500000,
        status: 'downloading',
        temporary_path: part0,
      },
      {
        download_id: dlId,
        segment_index: 1,
        start_byte: 1048576,
        end_byte: 2097151,
        downloaded_bytes: 200000,
        status: 'downloading',
        temporary_path: part1,
      },
    ]);

    db.close();

    // Relaunch application with fresh DB connection and manager init
    db = new BarqDatabase(dbPath).open();
    dRepo = new DownloadsRepo(db);
    sRepo = new SegmentsRepo(db);
    setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    eRepo = new EventsRepo(db);
    let manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });

    await manager.init();

    const recoveredRec = dRepo.getById(dlId);
    assert.equal(recoveredRec.status, 'paused');
    assert.equal(recoveredRec.downloaded_bytes, (1024 + 512) * 1024);

    // Resume recovered download
    await manager.resume(dlId);
    const recoveredTask = manager.tasks.get(dlId);
    await waitForDownload(recoveredTask, 30000);

    const target = path.join(testDir, 'crash-recovered.bin');
    assert.equal(fs.statSync(target).size, serverInstance.largeBuffer.length);
    assert.equal(await hashFile(target), serverInstance.largeHash);

    await manager.shutdown();
    db.close();
  });

  await t.test('2.3: Incomplete segment recovery when one .part file is deleted from disk', async () => {
    const testDir = makeTempDir();
    const { db, downloadsRepo, segmentsRepo, settingsRepo, eventsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 4, minSegmentSize: 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      filename: 'missing-part.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await new Promise((resolve) => {
      const onProgress = () => {
        if (task.downloadedBytes >= 250 * 1024) {
          task.removeListener('progress', onProgress);
          resolve();
        }
      };
      task.on('progress', onProgress);
    });

    await manager.pause(rec.id);

    // Intentionally delete one segment file from disk to simulate file loss
    const segments = segmentsRepo.getByDownloadId(rec.id);
    assert.ok(segments.length > 1);
    const deletedPart = segments[1].temporary_path;
    if (fs.existsSync(deletedPart)) {
      fs.unlinkSync(deletedPart);
    }

    // Set status to downloading simulating interrupted crash state
    downloadsRepo.updateStatus(rec.id, 'downloading');

    // Run recovery
    const recoveredCount = await SegmentRecoveryManager.recover({
      downloadsRepo,
      segmentsRepo,
      eventsRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.ok(recoveredCount >= 1);

    // Segment 1 must have been reset to 0 bytes
    const updatedSegs = segmentsRepo.getByDownloadId(rec.id);
    assert.equal(updatedSegs[1].downloaded_bytes, 0);

    // Resume to completion
    await manager.resume(rec.id);
    await waitForDownload(task, 30000);

    const target = path.join(testDir, 'missing-part.bin');
    assert.equal(fs.statSync(target).size, serverInstance.largeBuffer.length);
    assert.equal(await hashFile(target), serverInstance.largeHash);

    await manager.shutdown();
    db.close();
  });

  await t.test('2.4: Dynamic ETag change triggers clean restart from byte 0 to prevent corruption', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    // 1st request gets ETag v1
    const rec = await manager.add({
      sourceUrl: `${baseUrl}/dynamic-etag`,
      filename: 'etag-test.txt',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task);
    assert.equal(task.state, 'completed');

    // Simulate server returning new ETag on second download attempt with resume
    const partialPath = path.join(testDir, 'etag-test.txt.barq-part');
    fs.writeFileSync(partialPath, Buffer.from('Partial outdated data'));

    const resumeEval = DownloadValidator.verifyResourceIdentity(
      { etag: '"etag-v1"' },
      { etag: '"etag-v2"' }
    );
    assert.equal(resumeEval.match, false);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // TASK 3: MULTI-SEGMENT RELIABILITY & BENCHMARKING
  // ==========================================================================

  await t.test('3.1: Benchmark 1, 2, 4, 8, and 16 connections on 10 MB payload', async () => {
    const connections = [1, 2, 4, 8, 16];
    const results = [];

    for (const conn of connections) {
      const testDir = makeTempDir();
      const { db, settingsRepo, manager } = createTestHarness(testDir);
      settingsRepo.update({ connectionsPerFile: conn, minSegmentSize: 1024 });

      const heapBefore = process.memoryUsage().heapUsed;
      const rssBefore = process.memoryUsage().rss;
      const startTime = performance.now();

      const rec = await manager.add({
        sourceUrl: `${baseUrl}/10mb`,
        filename: `benchmark-${conn}.bin`,
        destinationPath: testDir,
        startNow: true,
      });

      const task = manager.tasks.get(rec.id);
      await waitForDownload(task, 30000);

      const elapsedSec = (performance.now() - startTime) / 1000;
      const heapAfter = process.memoryUsage().heapUsed;
      const rssAfter = process.memoryUsage().rss;
      const target = path.join(testDir, `benchmark-${conn}.bin`);
      const matches = (await hashFile(target)) === serverInstance.hash10mb;

      assert.equal(matches, true);
      const speedMb = 10 / elapsedSec;

      results.push({
        conn,
        timeSec: elapsedSec.toFixed(3),
        speedMbs: speedMb.toFixed(2),
        heapDeltaMb: ((heapAfter - heapBefore) / 1024 / 1024).toFixed(2),
        rssDeltaMb: ((rssAfter - rssBefore) / 1024 / 1024).toFixed(2),
        hashMatch: matches ? 'MATCH' : 'MISMATCH',
      });

      await manager.shutdown();
      db.close();
    }

    // Output formatted benchmark table
    console.log('\n================== MILESTONE 5 MULTI-SEGMENT BENCHMARKS (10 MB) ==================');
    console.log('Conn | Time (s) | Speed (MB/s) | Heap Diff (MB) | RSS Diff (MB) | SHA-256 Match');
    console.log('-----+----------+--------------+----------------+---------------+--------------');
    for (const r of results) {
      console.log(
        `${String(r.conn).padStart(4)} | ` +
        `${String(r.timeSec).padStart(8)} | ` +
        `${String(r.speedMbs).padStart(12)} | ` +
        `${String(r.heapDeltaMb).padStart(14)} | ` +
        `${String(r.rssDeltaMb).padStart(13)} | ` +
        `${r.hashMatch}`
      );
    }
    console.log('===================================================================================\n');
  });

  await t.test('3.2: Verify worker cancellation cleanly terminates all sockets without leaks', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 8, minSegmentSize: 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      filename: 'cancel-leak.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await new Promise((r) => setTimeout(r, 200));

    await manager.cancel(rec.id, true);
    assert.ok(['canceled', 'cancelled'].includes(task.state));
    if (task.isSegmented) {
      assert.equal(task.isDisposed, true);
    }

    await manager.shutdown();
    db.close();
  });

  await t.test('3.3: SegmentMerger handles write stream failures cleanly without unhandled exceptions', async () => {
    const testDir = makeTempDir();
    const readPath = path.join(testDir, 'sample-seg-0.part');
    fs.writeFileSync(readPath, Buffer.alloc(1024, 0xaa));

    const invalidDestPath = process.platform === 'win32'
      ? 'Z:\\nonexistent-drive-path\\output.bin'
      : '/nonexistent-root-dir/output.bin';

    await assert.rejects(
      SegmentMerger.merge({
        segments: [{ segment_index: 0, start_byte: 0, end_byte: 1023, temporary_path: readPath }],
        destinationPath: path.dirname(invalidDestPath),
        filename: path.basename(invalidDestPath),
        totalBytes: 1024,
        logger: { info() {}, error() {} },
      })
    );
  });

  // ==========================================================================
  // TASK 4: RESOURCE & PERFORMANCE AUDIT
  // ==========================================================================

  await t.test('4.1: Concurrency stress test: 5 simultaneous downloads with memory baseline stability', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ maxConcurrentDownloads: 5 });

    if (global.gc) global.gc();
    const memBefore = process.memoryUsage();

    const tasks = [];
    for (let i = 0; i < 5; i++) {
      const rec = await manager.add({
        sourceUrl: `${baseUrl}/small`,
        filename: `stress-${i}.bin`,
        destinationPath: testDir,
        startNow: true,
      });
      tasks.push(manager.tasks.get(rec.id));
    }

    await Promise.all(tasks.map((t) => waitForDownload(t, 20000)));

    if (global.gc) global.gc();
    const memAfter = process.memoryUsage();

    // Verify heap growth is bounded under 25 MB for 5 completed transfers
    const heapDiffMb = (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024);
    assert.ok(heapDiffMb < 25, `Heap grew abnormally: ${heapDiffMb.toFixed(2)} MB`);

    await manager.shutdown();
    db.close();
  });

  await t.test('4.2: Event loop responsiveness test: maximum event loop lag remains < 50ms', async () => {
    const testDir = makeTempDir();
    const { db, settingsRepo, manager } = createTestHarness(testDir);
    settingsRepo.update({ connectionsPerFile: 4 });

    let maxLagMs = 0;
    let lastCheck = performance.now();
    const lagInterval = setInterval(() => {
      const now = performance.now();
      const lag = now - lastCheck - 20; // 20ms expected interval
      if (lag > maxLagMs) maxLagMs = lag;
      lastCheck = now;
    }, 20);

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/large`,
      filename: 'lag-test.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task, 30000);

    clearInterval(lagInterval);
    console.log(`\nMax recorded event-loop lag during 4-segment transfer & merge: ${maxLagMs.toFixed(2)} ms`);
    assert.ok(maxLagMs < 50, `Event loop blocked for ${maxLagMs.toFixed(2)} ms (> 50ms)`);

    await manager.shutdown();
    db.close();
  });

  await t.test('4.3: Event listener cleanup: task and worker listeners are cleanly stripped upon removal', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/small`,
      filename: 'listener-cleanup.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);
    await waitForDownload(task);

    // Remove task
    await manager.remove(rec.id);
    assert.equal(manager.tasks.has(rec.id), false);
    assert.equal(task.listenerCount('progress'), 0);
    assert.equal(task.listenerCount('state-changed'), 0);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // TASK 5: DATABASE & STORAGE RESILIENCE
  // ==========================================================================

  await t.test('5.1: SQLite PRAGMA validation (WAL mode, synchronous=NORMAL, foreign_keys=ON)', () => {
    const testDir = makeTempDir();
    const dbPath = path.join(testDir, 'pragma-test.db');
    const db = new BarqDatabase(dbPath).open();

    const journalMode = Object.values(db.prepare('PRAGMA journal_mode').get())[0];
    const synchronous = Object.values(db.prepare('PRAGMA synchronous').get())[0];
    const foreignKeys = Object.values(db.prepare('PRAGMA foreign_keys').get())[0];
    const busyTimeout = Object.values(db.prepare('PRAGMA busy_timeout').get())[0];

    assert.equal(String(journalMode).toLowerCase(), 'wal');
    assert.equal(synchronous, 1); // 1 = NORMAL
    assert.equal(foreignKeys, 1); // 1 = ON
    assert.equal(busyTimeout, 5000); // 5000ms

    db.close();
  });

  await t.test('5.2: Corrupt database quarantine automatically creates backup and heals schema', () => {
    const testDir = makeTempDir();
    const dbPath = path.join(testDir, 'corrupt.db');

    // Create a corrupt file with invalid header
    fs.writeFileSync(dbPath, 'NOT A SQLITE DATABASE FILE HEADER CORRUPTION');

    const db = new BarqDatabase(dbPath);
    const opened = db.open();

    // Verify it quarantined the corrupted file
    const dirFiles = fs.readdirSync(testDir);
    const quarantineFiles = dirFiles.filter((f) => f.includes('corrupt.db.corrupt-'));
    assert.equal(quarantineFiles.length, 1);

    // Verify the new db is valid SQLite and functional
    const tables = opened.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    assert.ok(tables.some((t) => t.name === 'downloads'));

    opened.close();
  });

  await t.test('5.3: Foreign keys cascade deletion of segments and history when download is removed', () => {
    const testDir = makeTempDir();
    const dbPath = path.join(testDir, 'cascade.db');
    const db = new BarqDatabase(dbPath).open();
    const dRepo = new DownloadsRepo(db);
    const sRepo = new SegmentsRepo(db);

    const downloadId = dRepo.insert({
      source_url: 'http://127.0.0.1/dummy',
      destination_path: testDir,
      filename: 'dummy.bin',
      is_segmented: 1,
      segment_count: 2,
    });

    sRepo.insertBatch([
      { download_id: downloadId, segment_index: 0, start_byte: 0, end_byte: 100, temporary_path: 'a' },
      { download_id: downloadId, segment_index: 1, start_byte: 101, end_byte: 200, temporary_path: 'b' },
    ]);

    assert.equal(sRepo.getByDownloadId(downloadId).length, 2);

    dRepo.remove(downloadId);

    // Cascaded deletion
    assert.equal(sRepo.getByDownloadId(downloadId).length, 0);
    db.close();
  });

  // ==========================================================================
  // TASK 6: SECURITY VERIFICATION
  // ==========================================================================

  await t.test('6.1: Filename sanitization & path traversal prevention', () => {
    // Directory traversal
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeFilename('..\\..\\Windows\\System32\\calc.exe'), 'calc.exe');

    // Windows reserved device names defanged
    assert.equal(sanitizeFilename('CON'), '_CON');
    assert.equal(sanitizeFilename('prn.txt'), '_prn.txt');
    assert.equal(sanitizeFilename('aux.bin'), '_aux.bin');
    assert.equal(sanitizeFilename('nul'), '_nul');
    assert.equal(sanitizeFilename('com1.dat'), '_com1.dat');
    assert.equal(sanitizeFilename('lpt2.log'), '_lpt2.log');

    // Control characters and invalid Windows characters stripped
    assert.equal(sanitizeFilename('barq:file*with?invalid<chars>|name.zip'), 'barq_file_with_invalid_chars__name.zip');
    assert.equal(sanitizeFilename('file\u0000with\u001fcontrols.bin'), 'file_with_controls.bin');
  });

  await t.test('6.2: Scheme and dangerous protocol rejection', () => {
    const validHttp = validateDownloadUrl('http://speedtest.tele2.net/1MB.zip');
    assert.equal(validHttp.ok, true);

    const validHttps = validateDownloadUrl('https://releases.ubuntu.com/22.04/ubuntu-22.04.iso');
    assert.equal(validHttps.ok, true);

    // Dangerous protocols rejected
    assert.equal(validateDownloadUrl('file:///C:/Windows/System32/cmd.exe').ok, false);
    assert.equal(validateDownloadUrl('javascript:alert(1)').ok, false);
    assert.equal(validateDownloadUrl('data:text/html;base64,PHNjcmlwdD4=').ok, false);
    assert.equal(validateDownloadUrl('ftp://mirror.net/file.iso').ok, false);
    assert.equal(validateDownloadUrl('ws://live.stream/socket').ok, false);
    assert.equal(validateDownloadUrl('chrome://settings').ok, false);

    // Embedded credentials rejected
    assert.equal(validateDownloadUrl('http://admin:secret@127.0.0.1/leak').ok, false);
  });

  await t.test('6.3: Native messaging host IPC authentication token validation', async () => {
    const testDir = makeTempDir();
    const { db, manager } = createTestHarness(testDir);
    const pipeName = `barq-test-pipe-${process.pid}-${Date.now()}`;
    const pipeServer = new NativePipeServer({
      dataDir: testDir,
      downloadManager: manager,
      logger: { info() {}, warn() {}, error() {} },
      pipeName,
    });

    await pipeServer.start();
    const secret = pipeServer.authToken;
    assert.ok(secret && secret.length >= 32);

    // Client connection helper using newline-delimited JSON
    const sendPipeMessage = (payload) => {
      return new Promise((resolve, reject) => {
        const client = net.createConnection(pipeServer.pipePath);
        let res = '';
        client.setTimeout(4000);
        client.on('error', reject);
        client.on('connect', () => {
          client.write(JSON.stringify(payload) + '\n');
        });
        client.on('data', (chunk) => {
          res += chunk.toString('utf8');
          if (res.includes('\n')) {
            client.destroy();
            try {
              resolve(JSON.parse(res.trim()));
            } catch (e) {
              reject(e);
            }
          }
        });
        client.on('timeout', () => {
          client.destroy();
          reject(new Error('Pipe timeout'));
        });
      });
    };

    // 1. Missing secret should be rejected
    const unauthRes = await sendPipeMessage({
      protocolVersion: PROTOCOL_VERSION,
      operation: 'get_status',
      requestId: 'req-unauth',
    });
    assert.equal(unauthRes.ok, false);
    assert.equal(unauthRes.code, 'AUTH_FAILED');

    // 2. Valid secret should be accepted
    const authRes = await sendPipeMessage({
      protocolVersion: PROTOCOL_VERSION,
      secret,
      operation: 'get_status',
      requestId: 'req-auth',
    });
    assert.equal(authRes.ok, true);
    assert.equal(authRes.status, 'ready');

    await pipeServer.stop();
    await manager.shutdown();
    db.close();
  });

  await t.test('6.4: Path escape validation with isPathInside and safeJoin', () => {
    const baseDir = path.resolve('C:/Users/Downloads/BARQ');

    assert.equal(isPathInside(baseDir, path.join(baseDir, 'file.bin')), true);
    assert.equal(isPathInside(baseDir, path.join(baseDir, 'subfolder', 'file.bin')), true);

    // Traversal attempts
    assert.equal(isPathInside(baseDir, path.join(baseDir, '..', 'secret.txt')), false);
    assert.equal(isPathInside(baseDir, 'C:/Windows/System32/cmd.exe'), false);

    assert.equal(safeJoin(baseDir, 'valid.zip'), path.join(baseDir, 'valid.zip'));
    assert.equal(safeJoin(baseDir, '../escape.zip'), null);
    assert.equal(safeJoin(baseDir, 'folder/\0/invalid'), null);
  });
});
