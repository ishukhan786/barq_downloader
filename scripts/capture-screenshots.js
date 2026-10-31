'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const electronPath = require('electron');

const ROOT = path.join(__dirname, '..');
const TEST_DATA_DIR = path.join(ROOT, 'test-data', `screenshots-${Date.now()}`);
const SCREENSHOT_DIR = path.join(ROOT, 'assets', 'screenshots');

fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

console.log('--- BARQ SCREENSHOT CAPTURE RUNNER ---');
console.log('Isolated Data Directory:', TEST_DATA_DIR);

// Seed database directly using migrations logic
const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo, EventsRepo } = require('../src/main/db/downloads-repo');

const dbPath = path.join(TEST_DATA_DIR, 'barq.db');
const db = new BarqDatabase(dbPath);
db.open();

const dlRepo = new DownloadsRepo(db);
const eventsRepo = new EventsRepo(db);

const now = Date.now();

// 1. Active Multi-Segment Download
dlRepo.insert({
  source_url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-live-server-amd64.iso',
  filename: 'ubuntu-24.04-live-server-amd64.iso',
  destination_path: path.join(TEST_DATA_DIR, 'downloads', 'ubuntu-24.04-live-server-amd64.iso'),
  category: 'archive',
  total_bytes: 2684354560, // 2.5 GB
  downloaded_bytes: 1824522240, // ~68%
  status: 'downloading',
  segment_count: 8,
  is_segmented: 1,
  supports_ranges: 1,
  etag: '"7f8a9b-iso-v24"',
});

// 2. Completed Downloads
dlRepo.insert({
  source_url: 'https://nodejs.org/dist/v22.13.0/node-v22.13.0-x64.msi',
  filename: 'node-v22.13.0-x64.msi',
  destination_path: path.join(TEST_DATA_DIR, 'downloads', 'node-v22.13.0-x64.msi'),
  category: 'program',
  total_bytes: 35651584, // 34 MB
  downloaded_bytes: 35651584,
  status: 'completed',
  segment_count: 4,
  supports_ranges: 1,
  completed_at: now - 1000 * 60 * 18,
});

dlRepo.insert({
  source_url: 'https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user',
  filename: 'VSCodeUserSetup-x64-1.95.0.exe',
  destination_path: path.join(TEST_DATA_DIR, 'downloads', 'VSCodeUserSetup-x64-1.95.0.exe'),
  category: 'program',
  total_bytes: 102760448, // 98 MB
  downloaded_bytes: 102760448,
  status: 'completed',
  segment_count: 8,
  supports_ranges: 1,
  completed_at: now - 1000 * 60 * 52,
});

dlRepo.insert({
  source_url: 'https://archive.org/download/sample-audio-hd/barq-soundtrack-flac.zip',
  filename: 'barq-soundtrack-flac.zip',
  destination_path: path.join(TEST_DATA_DIR, 'downloads', 'barq-soundtrack-flac.zip'),
  category: 'archive',
  total_bytes: 432013312, // 412 MB
  downloaded_bytes: 432013312,
  status: 'completed',
  segment_count: 8,
  supports_ranges: 1,
  completed_at: now - 1000 * 60 * 135,
});

// 3. Queued Download
dlRepo.insert({
  source_url: 'https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.8.0-amd64-netinst.iso',
  filename: 'debian-12.8.0-amd64-netinst.iso',
  destination_path: path.join(TEST_DATA_DIR, 'downloads', 'debian-12.8.0-amd64-netinst.iso'),
  category: 'archive',
  total_bytes: 650117120, // 620 MB
  downloaded_bytes: 0,
  status: 'queued',
  segment_count: 8,
  supports_ranges: 1,
});

// Events
eventsRepo.add({ level: 'info', type: 'engine:init', message: 'BARQ Multi-Segment Acceleration Engine online' });
eventsRepo.add({ level: 'info', type: 'verify:complete', message: 'Verified SHA-256 hash bit-for-bit for "node-v22.13.0-x64.msi"' });
eventsRepo.add({ level: 'info', type: 'segment:connect', message: 'Connected 8 parallel stream workers to releases.ubuntu.com' });
eventsRepo.add({ level: 'info', type: 'pipe:listen', message: 'Extension Named Pipe Server active on \\\\.\\pipe\\barq-downloader-ipc' });

db.close();
console.log('Seeded database successfully with realistic download and telemetry records.');

// Spawn Electron in screenshot mode
console.log('Launching Electron to render dashboard and capture screenshots...');
const child = spawn(electronPath, ['.'], {
  cwd: ROOT,
  env: {
    ...process.env,
    BARQ_DATA_DIR: TEST_DATA_DIR,
    BARQ_VERIFY_MODE: 'screenshot',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (d) => {
  const str = d.toString('utf8');
  stdout += str;
  process.stdout.write(str);
});

child.stderr.on('data', (d) => {
  const str = d.toString('utf8');
  stderr += str;
  process.stderr.write(str);
});

child.on('close', (code) => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {}

  const match = stdout.match(/BARQ_SCREENSHOT_RESULT\s+(.*)/);
  if (match) {
    const res = JSON.parse(match[1]);
    console.log('\n========================================');
    console.log('  SCREENSHOTS CAPTURED SUCCESSFULLY!');
    console.log('========================================');
    console.log(`1920x1080: ${res.path1080} (${res.bytes1080} bytes)`);
    console.log(`1366x768:  ${res.path768} (${res.bytes768} bytes)`);
    process.exit(0);
  } else {
    console.error('\nScreenshot capture failed or did not return result. Exit code:', code);
    process.exit(1);
  }
});
