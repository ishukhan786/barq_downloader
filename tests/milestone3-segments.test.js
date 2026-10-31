'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

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

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function makeTempDir(prefix = 'barq-m3-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('BARQ Downloader — Milestone 3 Multi-Segment Engine Test Suite', async (t) => {
  const serverInstance = createTestServer();
  const baseUrl = await serverInstance.start();

  t.after(async () => {
    await serverInstance.stop();
  });

  // ==========================================================================
  // SECTION 1: SEGMENT PLANNING & INTEGER BOUNDARY ARITHMETIC
  // ==========================================================================

  await t.test('1.1: Plans exact boundaries for 1 MB file (4 segments)', () => {
    const total = 1024 * 1024; // 1,048,576
    const plan = SegmentPlanner.plan({
      downloadId: 1,
      totalBytes: total,
      connectionCount: 4,
      minSegmentSize: 1024,
      destinationPath: 'D:\\downloads',
      filename: 'file.bin',
    });

    assert.equal(plan.segmentCount, 4);
    assert.equal(plan.segments[0].start_byte, 0);
    assert.equal(plan.segments[0].end_byte, 262143);
    assert.equal(plan.segments[1].start_byte, 262144);
    assert.equal(plan.segments[1].end_byte, 524287);
    assert.equal(plan.segments[2].start_byte, 524288);
    assert.equal(plan.segments[2].end_byte, 786431);
    assert.equal(plan.segments[3].start_byte, 786432);
    assert.equal(plan.segments[3].end_byte, 1048575);

    // Assert exact sum
    const sum = plan.segments.reduce((acc, s) => acc + s.expected_bytes, 0);
    assert.equal(sum, total);
  });

  await t.test('1.2: Plans boundaries for 10 MB and 100 MB files with 8 and 16 connections', () => {
    const total10 = 10 * 1024 * 1024;
    const plan10 = SegmentPlanner.plan({
      downloadId: 2,
      totalBytes: total10,
      connectionCount: 8,
      minSegmentSize: 1024,
      destinationPath: 'D:\\downloads',
      filename: 'ten.bin',
    });
    assert.equal(plan10.segmentCount, 8);
    assert.equal(plan10.segments[7].end_byte, total10 - 1);

    const total100 = 100 * 1024 * 1024;
    const plan100 = SegmentPlanner.plan({
      downloadId: 3,
      totalBytes: total100,
      connectionCount: 16,
      minSegmentSize: 1024,
      destinationPath: 'D:\\downloads',
      filename: 'hundred.bin',
    });
    assert.equal(plan100.segmentCount, 16);
    assert.equal(plan100.segments[15].end_byte, total100 - 1);
  });

  await t.test('1.3: Handles uneven file sizes not divisible by connection count', () => {
    // 1,234,567 bytes divided into 8 segments (remainder = 7 bytes)
    const unevenSize = 1234567;
    const plan = SegmentPlanner.plan({
      downloadId: 4,
      totalBytes: unevenSize,
      connectionCount: 8,
      minSegmentSize: 1024,
      destinationPath: 'D:\\downloads',
      filename: 'uneven.bin',
    });

    assert.equal(plan.segmentCount, 8);
    // Verify no gaps, no overlaps, and final byte is exactly unevenSize - 1
    for (let i = 0; i < plan.segments.length; i++) {
      if (i > 0) {
        assert.equal(plan.segments[i].start_byte, plan.segments[i - 1].end_byte + 1);
      }
    }
    assert.equal(plan.segments[0].start_byte, 0);
    assert.equal(plan.segments[7].end_byte, unevenSize - 1);
    const sum = plan.segments.reduce((acc, s) => acc + s.expected_bytes, 0);
    assert.equal(sum, unevenSize);
  });

  await t.test('1.4: Clamps connection count within safe bounds [1, 16] and adapts small files', () => {
    const total = 500000; // 500 KB
    const planOver = SegmentPlanner.plan({
      downloadId: 5,
      totalBytes: total,
      connectionCount: 64, // Over max
      minSegmentSize: 100000,
      destinationPath: 'D:\\downloads',
      filename: 'small.bin',
    });
    // Clamped to 5 segments because 500KB / 100KB = 5
    assert.equal(planOver.segmentCount, 5);

    const planMin = SegmentPlanner.plan({
      downloadId: 6,
      totalBytes: total,
      connectionCount: 0, // Below min
      minSegmentSize: 100000,
      destinationPath: 'D:\\downloads',
      filename: 'small.bin',
    });
    assert.equal(planMin.segmentCount, 1);
  });

  await t.test('1.5: Rejects invalid or negative file sizes', () => {
    assert.throws(() => {
      SegmentPlanner.plan({
        downloadId: 7,
        totalBytes: -100,
        destinationPath: 'D:\\downloads',
        filename: 'bad.bin',
      });
    }, /Invalid totalBytes/);
  });

  // ==========================================================================
  // SECTION 2: RANGE SUPPORT DETECTION & ELIGIBILITY EVALUATION
  // ==========================================================================

  await t.test('2.1: Detects valid Range support on HTTP 206 server', async () => {
    const probe = await RangeSupportDetector.detect(`${baseUrl}/range-supported`, {
      minSegmentSize: 1024,
      autoSegmentation: true,
    });

    assert.equal(probe.supportsRanges, true);
    assert.equal(probe.statusCode, 206);
    assert.equal(probe.isEligible, true);
    assert.equal(probe.totalBytes, serverInstance.smallBuffer.length);
  });

  await t.test('2.2: Rejects segmentation when server ignores Range and returns HTTP 200', async () => {
    const probe = await RangeSupportDetector.detect(`${baseUrl}/range-ignored`, {
      minSegmentSize: 1024,
      autoSegmentation: true,
    });

    assert.equal(probe.supportsRanges, false);
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.isEligible, false);
    assert.match(probe.reason, /Server ignored Range header/);
  });

  await t.test('2.3: Rejects segmentation when file size is below minimum threshold', async () => {
    const probe = await RangeSupportDetector.detect(`${baseUrl}/range-supported`, {
      minSegmentSize: 50 * 1024 * 1024, // 50 MB threshold (file is 64 KB)
      autoSegmentation: true,
    });

    assert.equal(probe.supportsRanges, true);
    assert.equal(probe.isEligible, false);
    assert.match(probe.reason, /below minimum segmentation threshold/);
  });

  await t.test('2.4: Rejects segmentation when autoSegmentation setting is disabled', async () => {
    const probe = await RangeSupportDetector.detect(`${baseUrl}/10mb`, {
      autoSegmentation: false,
    });

    assert.equal(probe.isEligible, false);
    assert.match(probe.reason, /disabled by user settings/);
  });

  // ==========================================================================
  // SECTION 3: MULTI-SEGMENT EXECUTION & SEQUENTIAL MERGING
  // ==========================================================================

  await t.test('3.1: Downloads 2 MB file with 4 parallel segments and verifies exact SHA-256', async () => {
    const testDir = makeTempDir();
    const db = new BarqDatabase(path.join(testDir, 'm3-test.db')).open();
    const dRepo = new DownloadsRepo(db);
    const sRepo = new SegmentsRepo(db);
    const setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    const eRepo = new EventsRepo(db);

    const manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Ensure 4 connections per file
    setRepo.update({ connectionsPerFile: 4, minSegmentSize: 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/large`,
      filename: 'multi-2mb.bin',
      destinationPath: testDir,
      startNow: true,
    });

    assert.equal(rec.is_segmented, 1);
    assert.equal(rec.segment_count, 4);

    const task = manager.tasks.get(rec.id);
    assert.equal(task.isSegmented, true);

    await new Promise((resolve, reject) => {
      task.on('state-changed', (s) => {
        if (s.state === 'completed') resolve();
        else if (s.state === 'failed') reject(new Error(s.extra?.errorMessage || 'Segmented download failed'));
      });
    });

    const finalPath = path.join(testDir, 'multi-2mb.bin');
    assert.equal(fs.existsSync(finalPath), true);
    const downloadedSize = fs.statSync(finalPath).size;
    assert.equal(downloadedSize, serverInstance.largeBuffer.length);

    const downloadedHash = sha256(fs.readFileSync(finalPath));
    assert.equal(downloadedHash, serverInstance.largeHash);

    // Verify segment parts folder was cleanly removed
    const partsDir = path.join(testDir, 'multi-2mb.bin.barq-parts');
    assert.equal(fs.existsSync(partsDir), false);

    await manager.shutdown();
    db.close();
  });

  await t.test('3.2: Downloads uneven 1.23 MB file with 8 segments and verifies bit-for-bit match', async () => {
    const testDir = makeTempDir();
    const db = new BarqDatabase(path.join(testDir, 'uneven.db')).open();
    const dRepo = new DownloadsRepo(db);
    const sRepo = new SegmentsRepo(db);
    const setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    const eRepo = new EventsRepo(db);

    const manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    setRepo.update({ connectionsPerFile: 8, minSegmentSize: 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/uneven`,
      filename: 'uneven-result.bin',
      destinationPath: testDir,
      startNow: true,
    });

    assert.equal(rec.is_segmented, 1);
    assert.equal(rec.segment_count, 8);

    const task = manager.tasks.get(rec.id);
    await new Promise((resolve, reject) => {
      task.on('state-changed', (s) => {
        if (s.state === 'completed') resolve();
        else if (s.state === 'failed') reject(new Error(s.extra?.errorMessage));
      });
    });

    const finalPath = path.join(testDir, 'uneven-result.bin');
    assert.equal(fs.statSync(finalPath).size, serverInstance.bufUneven.length);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.hashUneven);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // SECTION 4: PAUSE, RESUME AND CONTINUITY
  // ==========================================================================

  await t.test('4.1: Pause during multi-segment download, verify .part files, and resume to completion', async () => {
    const testDir = makeTempDir();
    const db = new BarqDatabase(path.join(testDir, 'pause.db')).open();
    const dRepo = new DownloadsRepo(db);
    const sRepo = new SegmentsRepo(db);
    const setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    const eRepo = new EventsRepo(db);

    const manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    setRepo.update({ connectionsPerFile: 4, minSegmentSize: 1024 });

    const rec = await manager.add({
      sourceUrl: `${baseUrl}/slow-stream`,
      filename: 'paused-slow.bin',
      destinationPath: testDir,
      startNow: true,
    });

    const task = manager.tasks.get(rec.id);

    // Wait until at least 300 KB is downloaded, then pause
    await new Promise((resolve) => {
      const onProg = (p) => {
        if (p.downloadedBytes >= 300 * 1024) {
          task.off('progress', onProg);
          resolve();
        }
      };
      task.on('progress', onProg);
    });

    await manager.pause(rec.id);
    assert.equal(task.state, 'paused');

    // Verify .part files exist on disk
    const partsDir = path.join(testDir, 'paused-slow.bin.barq-parts');
    assert.equal(fs.existsSync(partsDir), true);
    const partFiles = fs.readdirSync(partsDir);
    assert.ok(partFiles.length > 0);

    const pausedBytesOnDisk = partFiles.reduce((acc, f) => acc + fs.statSync(path.join(partsDir, f)).size, 0);
    assert.ok(pausedBytesOnDisk >= 300 * 1024);

    // Resume
    await manager.resume(rec.id);
    await new Promise((resolve, reject) => {
      task.on('state-changed', (s) => {
        if (s.state === 'completed') resolve();
        else if (s.state === 'failed') reject(new Error(s.extra?.errorMessage));
      });
    });

    const finalPath = path.join(testDir, 'paused-slow.bin');
    assert.equal(fs.statSync(finalPath).size, serverInstance.largeBuffer.length);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.largeHash);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // SECTION 5: CRASH RECOVERY RECONCILIATION
  // ==========================================================================

  await t.test('5.1: Recovers interrupted segmented download upon application restart', async () => {
    const testDir = makeTempDir();
    const dbPath = path.join(testDir, 'crash.db');
    let db = new BarqDatabase(dbPath).open();
    let dRepo = new DownloadsRepo(db);
    let sRepo = new SegmentsRepo(db);
    let setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    let eRepo = new EventsRepo(db);

    // Create a segmented download record and 2 segments simulating an abrupt crash
    const totalBytes = 2 * 1024 * 1024;
    const partsDir = path.join(testDir, 'crash-test.bin.barq-parts');
    fs.mkdirSync(partsDir, { recursive: true });

    const part0 = path.join(partsDir, 'segment-000.part');
    const part1 = path.join(partsDir, 'segment-001.part');
    fs.writeFileSync(part0, serverInstance.largeBuffer.subarray(0, 1024 * 1024)); // Segment 0 complete (1 MB deterministic slice)
    fs.writeFileSync(part1, serverInstance.largeBuffer.subarray(1024 * 1024, (1024 + 512) * 1024));  // Segment 1 partial (512 KB deterministic slice)

    const dlId = dRepo.insert({
      source_url: `${baseUrl}/large`,
      filename: 'crash-test.bin',
      destination_path: testDir,
      status: 'downloading',
      total_bytes: totalBytes,
      downloaded_bytes: 800 * 1024, // Outdated byte count before crash
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
        downloaded_bytes: 500000, // Stale progress
        status: 'downloading',
        temporary_path: part0,
      },
      {
        download_id: dlId,
        segment_index: 1,
        start_byte: 1048576,
        end_byte: 2097151,
        downloaded_bytes: 200000, // Stale progress
        status: 'downloading',
        temporary_path: part1,
      },
    ]);

    // Close database simulating abrupt termination
    db.close();

    // Reopen database and launch new DownloadManager simulating app startup
    db = new BarqDatabase(dbPath).open();
    dRepo = new DownloadsRepo(db);
    sRepo = new SegmentsRepo(db);
    setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    eRepo = new EventsRepo(db);

    const manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Run init to trigger recovery
    await manager.init();

    // Assert that database records were reconciled to exact disk bytes
    const recoveredRec = dRepo.getById(dlId);
    assert.equal(recoveredRec.status, 'paused');
    assert.equal(recoveredRec.downloaded_bytes, (1024 + 512) * 1024); // 1.5 MB

    const seg0 = sRepo.getById(1);
    assert.equal(seg0.status, 'completed');
    assert.equal(seg0.downloaded_bytes, 1024 * 1024);

    const seg1 = sRepo.getById(2);
    assert.equal(seg1.status, 'pending');
    assert.equal(seg1.downloaded_bytes, 512 * 1024);

    // Resume and verify completed file
    await manager.resume(dlId);
    const task = manager.tasks.get(dlId);
    await new Promise((resolve, reject) => {
      task.on('state-changed', (s) => {
        if (s.state === 'completed') resolve();
        else if (s.state === 'failed') reject(new Error(s.extra?.errorMessage));
      });
    });

    const finalPath = path.join(testDir, 'crash-test.bin');
    assert.equal(fs.statSync(finalPath).size, totalBytes);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.largeHash);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // SECTION 6: AUTOMATIC FALLBACK TO SINGLE CONNECTION
  // ==========================================================================

  await t.test('6.1: Gracefully falls back to single connection when server does not support ranges', async () => {
    const testDir = makeTempDir();
    const db = new BarqDatabase(path.join(testDir, 'fallback.db')).open();
    const dRepo = new DownloadsRepo(db);
    const sRepo = new SegmentsRepo(db);
    const setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    const eRepo = new EventsRepo(db);

    const manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    setRepo.update({ autoSegmentation: true, autoFallback: true });

    // /range-ignored returns 200 with full content on Range requests
    const rec = await manager.add({
      sourceUrl: `${baseUrl}/range-ignored`,
      filename: 'fallback-file.bin',
      destinationPath: testDir,
      startNow: true,
    });

    // Should be automatically classified as non-segmented during probe
    assert.equal(rec.is_segmented, 0);
    assert.ok(rec.fallback_reason.includes('Server ignored Range header'));

    const task = manager.tasks.get(rec.id);
    assert.equal(task.isSegmented, undefined); // standard DownloadTask

    await new Promise((resolve, reject) => {
      task.on('state-changed', (s) => {
        if (s.state === 'completed') resolve();
        else if (s.state === 'failed') reject(new Error(s.extra?.errorMessage));
      });
    });

    const finalPath = path.join(testDir, 'fallback-file.bin');
    assert.equal(fs.statSync(finalPath).size, serverInstance.smallBuffer.length);
    assert.equal(sha256(fs.readFileSync(finalPath)), serverInstance.smallHash);

    await manager.shutdown();
    db.close();
  });

  // ==========================================================================
  // SECTION 7: PERFORMANCE BENCHMARKING (1 vs 2 vs 4 vs 8 vs 16 CONNECTIONS)
  // ==========================================================================

  await t.test('7.1: Comparative performance benchmarks across 1, 2, 4, 8, and 16 connections', async () => {
    const testDir = makeTempDir();
    const db = new BarqDatabase(path.join(testDir, 'bench.db')).open();
    const dRepo = new DownloadsRepo(db);
    const sRepo = new SegmentsRepo(db);
    const setRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));
    const eRepo = new EventsRepo(db);

    const manager = new DownloadManager({
      downloadsRepo: dRepo,
      settingsRepo: setRepo,
      eventsRepo: eRepo,
      logger: { info() {}, warn() {}, error() {} },
    });

    const connectionCounts = [1, 2, 4, 8, 16];
    const benchmarkResults = [];

    console.log('\n--- MILESTONE 3 PERFORMANCE BENCHMARK (10 MB PAYLOAD) ---');
    console.log('Conn | Time (s) | Speed (MB/s) | RAM Diff (MB) | SHA-256 Match');
    console.log('-----+----------+--------------+---------------+--------------');

    for (const conns of connectionCounts) {
      setRepo.update({
        connectionsPerFile: conns,
        autoSegmentation: conns > 1,
        minSegmentSize: 1024,
      });

      const filename = `bench-${conns}-conn.bin`;
      const memBefore = process.memoryUsage().heapUsed;
      const t0 = process.hrtime.bigint();

      const rec = await manager.add({
        sourceUrl: `${baseUrl}/10mb`,
        filename,
        destinationPath: testDir,
        startNow: true,
      });

      const task = manager.tasks.get(rec.id);
      await new Promise((resolve, reject) => {
        task.on('state-changed', (s) => {
          if (s.state === 'completed') resolve();
          else if (s.state === 'failed') reject(new Error(s.extra?.errorMessage));
        });
      });

      const t1 = process.hrtime.bigint();
      const memAfter = process.memoryUsage().heapUsed;

      const durationSec = Number(t1 - t0) / 1e9;
      const fileSizeMb = serverInstance.buf10mb.length / (1024 * 1024);
      const speedMbSec = durationSec > 0 ? (fileSizeMb / durationSec).toFixed(2) : 'N/A';
      const memDiffMb = ((memAfter - memBefore) / (1024 * 1024)).toFixed(2);

      const filePath = path.join(testDir, filename);
      const fileHash = sha256(fs.readFileSync(filePath));
      const hashMatch = fileHash === serverInstance.hash10mb;

      assert.equal(hashMatch, true);
      assert.equal(fs.statSync(filePath).size, serverInstance.buf10mb.length);

      benchmarkResults.push({
        concurrency: conns,
        durationSec: Number(durationSec.toFixed(3)),
        speedMbSec: Number(speedMbSec),
        memDiffMb: Number(memDiffMb),
        hashMatch,
      });

      console.log(
        `${String(conns).padStart(4)} | ` +
        `${durationSec.toFixed(3).padStart(8)} | ` +
        `${String(speedMbSec).padStart(12)} | ` +
        `${String(memDiffMb).padStart(13)} | ` +
        `MATCH`
      );
    }

    console.log('----------------------------------------------------------\n');

    assert.equal(benchmarkResults.length, 5);
    for (const r of benchmarkResults) {
      assert.equal(r.hashMatch, true);
    }

    await manager.shutdown();
    db.close();
  });
});
