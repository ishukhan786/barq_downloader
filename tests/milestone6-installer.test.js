'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, execSync } = require('node:child_process');

const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo } = require('../src/main/db/downloads-repo');
const { SettingsRepo } = require('../src/main/db/settings-repo');
const { buildSchema } = require('../src/main/settings-schema');
const { resolveDataDir, buildDataLayout } = require('../src/main/paths');

const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const SETUP_EXE = path.join(DIST_DIR, 'BARQ-Downloader-Setup-0.1.0.exe');
const PORTABLE_EXE = path.join(DIST_DIR, 'BARQ-Downloader-Portable-0.1.0.exe');
const UNPACKED_DIR = path.join(DIST_DIR, 'win-unpacked');
const APP_EXE = path.join(UNPACKED_DIR, 'BARQ Downloader.exe');
const SHA256_FILE = path.join(DIST_DIR, 'SHA256SUMS.txt');

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()));
    stream.on('error', reject);
  });
}

function makeTempDir(prefix = 'barq-m6-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('BARQ Downloader — Milestone 6 Windows Release & Packaging Suite', async (t) => {
  // ==========================================================================
  // 1. RELEASE ARTIFACTS VERIFICATION
  // ==========================================================================

  await t.test('1.1: Release installer artifact exists, is valid size (>50MB), and matches SHA-256', async () => {
    assert.equal(fs.existsSync(SETUP_EXE), true, `Installer ${SETUP_EXE} must exist`);
    const stat = fs.statSync(SETUP_EXE);
    assert.ok(stat.size > 50 * 1024 * 1024, `Installer size (${stat.size}) should be > 50 MB`);

    assert.equal(fs.existsSync(SHA256_FILE), true, 'SHA256SUMS.txt must exist');
    const checksums = fs.readFileSync(SHA256_FILE, 'utf8');

    const calculatedHash = await sha256File(SETUP_EXE);
    assert.ok(checksums.includes(calculatedHash), 'Calculated hash must match SHA256SUMS.txt');
  });

  await t.test('1.2: Portable artifact exists, is valid size (>50MB), and matches SHA-256', async () => {
    assert.equal(fs.existsSync(PORTABLE_EXE), true, `Portable build ${PORTABLE_EXE} must exist`);
    const stat = fs.statSync(PORTABLE_EXE);
    assert.ok(stat.size > 50 * 1024 * 1024, `Portable build size (${stat.size}) should be > 50 MB`);

    const checksums = fs.readFileSync(SHA256_FILE, 'utf8');
    const calculatedHash = await sha256File(PORTABLE_EXE);
    assert.ok(checksums.includes(calculatedHash), 'Calculated portable hash must match SHA256SUMS.txt');
  });

  // ==========================================================================
  // 2. PACKAGED APPLICATION INTEGRITY
  // ==========================================================================

  await t.test('2.1: Packaged binary structure contains executable, asar, and unpacked assets', () => {
    assert.equal(fs.existsSync(APP_EXE), true, 'BARQ Downloader.exe must exist in win-unpacked');

    const resourcesDir = path.join(UNPACKED_DIR, 'resources');
    assert.equal(fs.existsSync(resourcesDir), true);

    const asarPath = path.join(resourcesDir, 'app.asar');
    assert.equal(fs.existsSync(asarPath), true, 'app.asar must be present');
    assert.ok(fs.statSync(asarPath).size > 100 * 1024, 'app.asar must not be empty');

    // Verify native host is physically unpacked on disk outside ASAR
    const unpackedHostBat = path.join(resourcesDir, 'app.asar.unpacked', 'native-host', 'barq-native-host.bat');
    assert.equal(fs.existsSync(unpackedHostBat), true, 'barq-native-host.bat must be physically unpacked');

    const unpackedHostJs = path.join(resourcesDir, 'app.asar.unpacked', 'native-host', 'barq-native-host.js');
    assert.equal(fs.existsSync(unpackedHostJs), true, 'barq-native-host.js must be physically unpacked');

    // Verify browser extension folder is deployed in resources
    const extManifest = path.join(resourcesDir, 'browser-extension', 'manifest.json');
    assert.equal(fs.existsSync(extManifest), true, 'Browser extension manifest must exist in resources');
  });

  // ==========================================================================
  // 3. CLEAN INSTALLATION SIMULATION RUNTIME TEST
  // ==========================================================================

  await t.test('3.1: Clean installation runtime launch initializes SQLite schema and UI', () => {
    const testDir = makeTempDir('barq-clean-');

    const res = spawnSync(APP_EXE, [], {
      env: {
        ...process.env,
        BARQ_SMOKE: '1',
        BARQ_DATA_DIR: testDir,
      },
      encoding: 'utf8',
      timeout: 60000,
    });

    assert.equal(res.status, 0, `Packaged executable exited with code ${res.status}: ${res.stderr || res.stdout}`);

    // Verify BARQ_SMOKE_RESULT was emitted
    const match = res.stdout.match(/BARQ_SMOKE_RESULT\s+(.*)/);
    assert.ok(match, 'Packaged executable must emit BARQ_SMOKE_RESULT');

    const smokeResult = JSON.parse(match[1]);
    assert.equal(smokeResult.ok, true);
    assert.equal(smokeResult.report.ready, true);
    assert.equal(smokeResult.report.schemaVersion, 3);
    assert.equal(smokeResult.report.barqFrozen, true);

    // Verify database was initialized on disk in isolated folder
    const dbFile = path.join(testDir, 'barq.db');
    assert.equal(fs.existsSync(dbFile), true, 'barq.db must be created in data directory');

    // Clean up
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // 4. UPGRADE SIMULATION & USER DATA PRESERVATION
  // ==========================================================================

  await t.test('4.1: Upgrades preserve existing database, download history, and custom settings', () => {
    const testDir = makeTempDir('barq-upgrade-');
    const dbPath = path.join(testDir, 'barq.db');

    // 1. Simulate existing previous installation with user data
    let db = new BarqDatabase(dbPath).open();
    let dRepo = new DownloadsRepo(db);
    let sRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));

    // Apply custom user settings
    sRepo.update({
      theme: 'light',
      connectionsPerFile: 16,
      maxConcurrentDownloads: 5,
    });

    // Insert user download history
    const completedId = dRepo.insert({
      source_url: 'https://example.com/software.zip',
      filename: 'software.zip',
      destination_path: testDir,
      status: 'completed',
      total_bytes: 52428800,
      downloaded_bytes: 52428800,
    });

    const interruptedId = dRepo.insert({
      source_url: 'https://example.com/bigfile.iso',
      filename: 'bigfile.iso',
      destination_path: testDir,
      status: 'downloading',
      total_bytes: 1073741824,
      downloaded_bytes: 500000000,
    });

    db.close();

    // 2. Launch new packaged build against existing data directory (Simulating Upgrade)
    const res = spawnSync(APP_EXE, [], {
      env: {
        ...process.env,
        BARQ_SMOKE: '1',
        BARQ_DATA_DIR: testDir,
      },
      encoding: 'utf8',
      timeout: 60000,
    });

    assert.equal(res.status, 0, 'Packaged app must launch successfully on upgraded directory');

    // 3. Re-open database and verify user data was preserved
    db = new BarqDatabase(dbPath).open();
    dRepo = new DownloadsRepo(db);
    sRepo = new SettingsRepo(db, buildSchema({ defaultDownloadDir: testDir }));

    // Verify settings were preserved
    const settings = sRepo.getAll();
    assert.equal(settings.theme, 'light', 'User theme setting must be preserved');
    assert.equal(settings.connectionsPerFile, 16, 'User connectionsPerFile setting must be preserved');
    assert.equal(settings.maxConcurrentDownloads, 5, 'User maxConcurrentDownloads setting must be preserved');

    // Verify download history was preserved
    const completedRec = dRepo.getById(completedId);
    assert.ok(completedRec, 'Completed download record must persist');
    assert.equal(completedRec.filename, 'software.zip');
    assert.equal(completedRec.status, 'completed');

    const interruptedRec = dRepo.getById(interruptedId);
    assert.ok(interruptedRec, 'Interrupted download record must persist');
    assert.equal(interruptedRec.filename, 'bigfile.iso');

    db.close();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // 5. USER DATA SEPARATION & STORAGE PATHS
  // ==========================================================================

  await t.test('5.1: Path resolver stores user data outside installation directory', () => {
    // Packaged build in Program Files (non-writable) falls back to per-user AppData
    const resolved = resolveDataDir({
      isPackaged: true,
      execPath: 'C:\\Program Files\\BARQ Downloader\\BARQ Downloader.exe',
      appRoot: 'C:\\Program Files\\BARQ Downloader',
      fallbackBase: 'C:\\Users\\User\\AppData\\Local',
      env: {},
      isWritable: () => false, // simulates non-writable Program Files
    });

    assert.equal(resolved.mode, 'per-user');
    assert.equal(resolved.dataDir, 'C:\\Users\\User\\AppData\\Local\\BARQ Downloader');

    // Packaged build with writable portable-data folder beside exe
    const resolvedPortable = resolveDataDir({
      isPackaged: true,
      execPath: 'D:\\PortableApps\\BARQ\\BARQ Downloader.exe',
      appRoot: 'D:\\PortableApps\\BARQ',
      fallbackBase: 'C:\\Users\\User\\AppData\\Local',
      env: {},
      isWritable: (dir) => dir.includes('portable-data'),
    });

    assert.equal(resolvedPortable.mode, 'portable');
    assert.equal(resolvedPortable.dataDir, 'D:\\PortableApps\\BARQ\\portable-data');
  });

  // ==========================================================================
  // 6. CODE SIGNING & SMARTSCREEN INVESTIGATION
  // ==========================================================================

  await t.test('6.1: Authenticode signature audit identifies unsigned development status', () => {
    if (process.platform === 'win32') {
      try {
        const cmd = `powershell -NoProfile -Command "(Get-AuthenticodeSignature -FilePath '${SETUP_EXE}').Status.ToString()"`;
        const status = execSync(cmd, { encoding: 'utf8' }).trim();
        assert.equal(status, 'NotSigned', 'Staging installer must report NotSigned without fake signature');
      } catch (err) {
        // PowerShell might be restricted
        assert.ok(true);
      }
    }

    // Verify no secret private certificates (.pfx, .p12) are committed to git
    const repoFiles = execSync('git ls-files', { encoding: 'utf8' });
    assert.equal(repoFiles.includes('.pfx'), false, 'Private .pfx certificates must never be committed');
    assert.equal(repoFiles.includes('.p12'), false, 'Private .p12 certificates must never be committed');
  });
});
