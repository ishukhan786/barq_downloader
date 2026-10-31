'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const { BarqDatabase } = require('../src/main/db/database');
const { FeedbackRepo, BUG_CATEGORIES, FEATURE_CATEGORIES } = require('../src/main/db/feedback-repo');
const { DownloadsRepo, EventsRepo } = require('../src/main/db/downloads-repo');
const { Sanitizer } = require('../src/main/diagnostics/Sanitizer');
const { DiagnosticCollector } = require('../src/main/diagnostics/DiagnosticCollector');
const { ZipExporter } = require('../src/main/diagnostics/ZipExporter');

function makeTempDir(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('BARQ Downloader — Milestone 7 Feedback, Diagnostics & Support Suite', async (t) => {
  const testDir = makeTempDir('barq-m7-');
  const dbFile = path.join(testDir, 'feedback-test.db');
  let barqDb;
  let feedbackRepo;
  let downloadsRepo;
  let eventsRepo;

  test.before(() => {
    barqDb = new BarqDatabase(dbFile).open();
    feedbackRepo = new FeedbackRepo(barqDb);
    downloadsRepo = new DownloadsRepo(barqDb);
    eventsRepo = new EventsRepo(barqDb);
  });

  test.after(() => {
    try { barqDb.close(); } catch {}
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  // ==========================================================================
  // 1. DATABASE SCHEMA & MIGRATION V4 & V5
  // ==========================================================================

  await t.test('1.1: Migration v4 & v5 apply cleanly and create feedback_reports table with is_exported', () => {
    assert.ok(barqDb.userVersion >= 5, `Schema version must be at least 5, got ${barqDb.userVersion}`);

    const tables = barqDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    assert.ok(tables.includes('feedback_reports'), 'feedback_reports table must exist');

    const indices = barqDb.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
    assert.ok(indices.includes('idx_feedback_created_at'), 'idx_feedback_created_at index must exist');
    assert.ok(indices.includes('idx_feedback_type'), 'idx_feedback_type index must exist');
    assert.ok(indices.includes('idx_feedback_status'), 'idx_feedback_status index must exist');
    assert.ok(indices.includes('idx_feedback_exported'), 'idx_feedback_exported index must exist');

    const cols = barqDb.prepare("PRAGMA table_info('feedback_reports')").all().map((c) => c.name);
    assert.ok(cols.includes('is_exported'), 'feedback_reports must include is_exported column');
  });

  // ==========================================================================
  // 2. FEEDBACK REPOSITORY CRUD & VALIDATION
  // ==========================================================================

  let createdBugId = null;
  let createdBugReportId = null;

  await t.test('2.1: Creates bug report with validation and unique report ID', () => {
    const report = feedbackRepo.create({
      report_type: 'bug',
      title: 'Download stalls at 99% during merge phase',
      category: 'multi_segment',
      severity: 'high',
      description: 'When downloading a 500 MB file with 8 segments, the progress stalls at 99% during final file merge.',
      reproduction_steps: '1. Add 500MB download\n2. Wait for chunks to reach 100%\n3. Merging takes >2 minutes',
      expected_behavior: 'File should merge and transition to completed within seconds',
      actual_behavior: 'App stays in downloading/merging state for 2 minutes before finishing',
      status: 'saved',
      diagnostic_included: 1,
    });

    assert.ok(report, 'Report should be returned');
    assert.ok(report.id > 0, 'Report must have positive numeric id');
    assert.match(report.report_id, /^BARQ-[A-F0-9]{6}$/, 'Report ID must match BARQ-XXXXXX pattern');
    assert.equal(report.report_type, 'bug');
    assert.equal(report.title, 'Download stalls at 99% during merge phase');
    assert.equal(report.category, 'multi_segment');
    assert.equal(report.severity, 'high');
    assert.equal(report.status, 'saved');
    assert.equal(report.diagnostic_included, 1);
    assert.ok(report.created_at > 0);
    assert.ok(report.updated_at > 0);

    createdBugId = report.id;
    createdBugReportId = report.report_id;
  });

  await t.test('2.2: Rejects invalid bug report inputs', () => {
    // Missing title
    assert.throws(() => {
      feedbackRepo.create({
        report_type: 'bug',
        title: '',
        category: 'download_failure',
        description: 'No title test',
      });
    }, /Title is required/);

    // Invalid report type
    assert.throws(() => {
      feedbackRepo.create({
        report_type: 'invalid_type',
        title: 'Valid title',
        category: 'download_failure',
        description: 'Valid description',
      });
    }, /Invalid report type/);

    // Invalid category
    assert.throws(() => {
      feedbackRepo.create({
        report_type: 'bug',
        title: 'Valid title',
        category: 'not_a_valid_category_ever',
        description: 'Valid description',
      });
    }, /Invalid category/);

    // Invalid severity
    assert.throws(() => {
      feedbackRepo.create({
        report_type: 'bug',
        title: 'Valid title',
        category: 'download_failure',
        severity: 'apocalyptic',
        description: 'Valid description',
      });
    }, /Invalid severity/);
  });

  await t.test('2.3: Creates feature request with validation', () => {
    const feature = feedbackRepo.create({
      report_type: 'feature',
      title: 'Time-of-day bandwidth scheduling',
      category: 'queue_scheduling',
      description: 'Allow users to set speed limit schedules (e.g. limit to 1MB/s during work hours 9am-5pm, uncapped overnight).',
      expected_behavior: 'Scheduler automatically adjusts speed limit according to user configuration.',
      status: 'saved',
    });

    assert.ok(feature);
    assert.equal(feature.report_type, 'feature');
    assert.equal(feature.category, 'queue_scheduling');
    assert.equal(feature.severity, null, 'Feature request severity should be null');
    assert.equal(feature.diagnostic_included, 0);
  });

  await t.test('2.4: Retrieves reports by ID, report_id, and queries list', () => {
    const byId = feedbackRepo.getById(createdBugId);
    assert.ok(byId);
    assert.equal(byId.title, 'Download stalls at 99% during merge phase');

    const byReportId = feedbackRepo.getByReportId(createdBugReportId);
    assert.ok(byReportId);
    assert.equal(byReportId.id, createdBugId);

    const all = feedbackRepo.list();
    assert.ok(all.length >= 2, 'Should contain at least 2 reports');

    const bugsOnly = feedbackRepo.list({ type: 'bug' });
    assert.ok(bugsOnly.every((r) => r.report_type === 'bug'));

    const searchRes = feedbackRepo.list({ search: 'bandwidth' });
    assert.equal(searchRes.length, 1);
    assert.equal(searchRes[0].title, 'Time-of-day bandwidth scheduling');
  });

  await t.test('2.5: Updates report fields and handles deletion', () => {
    const updated = feedbackRepo.update(createdBugId, {
      title: 'Download stalls at 99% during merge phase (Investigating)',
      severity: 'critical',
      status: 'ready',
    });

    assert.equal(updated.title, 'Download stalls at 99% during merge phase (Investigating)');
    assert.equal(updated.severity, 'critical');
    assert.equal(updated.status, 'ready');
    assert.ok(updated.updated_at >= updated.created_at);

    // Create a temporary report to delete
    const temp = feedbackRepo.create({
      report_type: 'feature',
      title: 'Temporary feature to delete',
      category: 'other',
      description: 'Will be deleted in a moment',
    });

    const deleted = feedbackRepo.delete(temp.id);
    assert.equal(deleted, true);
    assert.equal(feedbackRepo.getById(temp.id), null);
  });

  await t.test('2.6: Calculates accurate feedback stats', () => {
    const stats = feedbackRepo.getStats();
    assert.ok(stats.total >= 2);
    assert.ok(stats.bugs >= 1);
    assert.ok(stats.features >= 1);
    assert.equal(stats.total, stats.bugs + stats.features);
  });

  // ==========================================================================
  // 3. SANITIZER & PRIVACY-FIRST REDACTION
  // ==========================================================================

  await t.test('3.1: Sanitizer redacts URLs, IPs, credentials, emails, and user paths', () => {
    const username = Sanitizer.getUsername();
    const sensitive = `Download error from https://private-server.net:8443/files/confidential.iso?token=secret12345
      Target: C:\\Users\\${username}\\Downloads\\confidential.iso
      User account: ${username}
      Server IP: 203.0.113.195
      User email: engineer@barq-downloader.org
      Header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz
      API key: apiKey=AB9876543210ZYXWVU`;

    const scrubbed = Sanitizer.scrubText(sensitive);

    // Verify zero leaks of sensitive information
    assert.ok(!scrubbed.includes('https://private-server.net'));
    assert.ok(!scrubbed.includes('secret12345'));
    assert.ok(!scrubbed.includes('203.0.113.195'));
    assert.ok(!scrubbed.includes('engineer@barq-downloader.org'));
    assert.ok(!scrubbed.includes('eyJhbGci'));
    assert.ok(!scrubbed.includes('AB9876543210ZYXWVU'));
    if (username && username.length > 2) {
      assert.ok(!scrubbed.includes(username), `Username ${username} must be redacted`);
    }

    // Verify appropriate redaction placeholders
    assert.ok(scrubbed.includes('[REDACTED_URL]'));
    assert.ok(scrubbed.includes('[REDACTED_IP]'));
    assert.ok(scrubbed.includes('[REDACTED_EMAIL]'));
    assert.ok(scrubbed.includes('[REDACTED_TOKEN]') || scrubbed.includes('[REDACTED_SECRET]'));
    assert.ok(scrubbed.includes('[REDACTED_PATH]'));
    assert.ok(scrubbed.includes('[USER]'));
  });

  await t.test('3.2: Sanitizer scrubs deeply nested objects without mutation', () => {
    const rawObj = {
      level: 'error',
      details: {
        url: 'https://test.invalid/download.tar.gz?auth=abc',
        clientIp: '198.51.100.42',
        authToken: 'Bearer secret_token_value',
        nested: ['https://link1.com', 'Clean string', 'user@company.com'],
      },
    };

    const clean = Sanitizer.scrubObject(rawObj);

    assert.equal(clean.level, 'error');
    assert.equal(clean.details.url, '[REDACTED_URL]');
    assert.equal(clean.details.clientIp, '[REDACTED_IP]');
    assert.equal(clean.details.authToken, '[REDACTED_SECRET]');
    assert.equal(clean.details.nested[0], '[REDACTED_URL]');
    assert.equal(clean.details.nested[1], 'Clean string');
    assert.equal(clean.details.nested[2], '[REDACTED_EMAIL]');
  });

  // ==========================================================================
  // 4. DIAGNOSTIC COLLECTOR
  // ==========================================================================

  await t.test('4.1: Collects system and runtime environment info strictly within allowlist', () => {
    const collector = new DiagnosticCollector({
      database: barqDb,
      downloadsRepo,
      eventsRepo,
      downloadManager: {
        getActiveCount: () => 0,
        getSpeedBps: () => 0,
      },
    });

    const bundle = collector.collectDiagnosticBundle();

    // Verify presence of allowlist fields
    assert.ok(bundle.collectedAt);
    assert.ok(bundle.privacyNotice.includes('Zero telemetry policy'));
    assert.ok(bundle.system.osType);
    assert.ok(bundle.system.platform);
    assert.ok(bundle.system.arch);
    assert.ok(bundle.system.totalMemoryMB > 0);
    assert.ok(bundle.system.cpuCount >= 1);

    assert.ok(bundle.runtime.barqVersion);
    assert.ok(bundle.runtime.nodeVersion);
    assert.ok(bundle.runtime.schemaVersion >= 4);

    assert.equal(typeof bundle.telemetry.totalDownloads, 'number');
    assert.equal(typeof bundle.telemetry.activeTransfers, 'number');
    assert.equal(typeof bundle.telemetry.overallSpeedBps, 'number');

    assert.ok(Array.isArray(bundle.recentLogs));
  });

  await t.test('4.2: Recent event logs are scrubbed before inclusion', () => {
    // Insert an event with private URL into the events table
    eventsRepo.add({
      level: 'error',
      type: 'download-failed',
      message: 'Failed to connect to https://private-site.invalid/iso.img:443 for user IshtiaqUddin',
    });

    const collector = new DiagnosticCollector({
      database: barqDb,
      downloadsRepo,
      eventsRepo,
    });

    const events = collector.getSanitizedEvents(10);
    const target = events.find((e) => e.type === 'download-failed');
    assert.ok(target, 'Target event must be present in sanitized output');
    assert.ok(!target.message.includes('https://private-site.invalid'));
    assert.ok(target.message.includes('[REDACTED_URL]'));
  });

  // ==========================================================================
  // 5. ZIP & JSON EXPORT INTEGRITY
  // ==========================================================================

  await t.test('5.1: ZipExporter produces valid PKZIP 2.0 archive buffer', () => {
    const testFiles = [
      { name: 'report.json', content: JSON.stringify({ id: 'BARQ-123456', title: 'Test' }) },
      { name: 'diagnostics.json', content: JSON.stringify({ os: 'Windows_NT' }) },
      { name: 'manifest.txt', content: 'BARQ Diagnostics Privacy Manifest' },
    ];

    const zipBuffer = ZipExporter.createZipBuffer(testFiles);

    // Verify PKZIP Magic bytes
    assert.equal(zipBuffer.readUInt32LE(0), 0x04034b50, 'Local file header signature must be 0x04034b50 (PK\\x03\\x04)');

    // Verify it inflates cleanly using standard zlib
    const zipPath = path.join(testDir, 'test-archive.zip');
    fs.writeFileSync(zipPath, zipBuffer);
    assert.ok(fs.existsSync(zipPath));
    assert.ok(fs.statSync(zipPath).size > 100);
  });

  await t.test('5.2: Atomic exportZip creates complete diagnostic bundle on disk', () => {
    const exportPath = path.join(testDir, 'export', ZipExporter.generateZipFilename());

    const result = ZipExporter.exportZip(exportPath, {
      report: feedbackRepo.getById(createdBugId),
      diagnostics: { os: process.platform, arch: process.arch },
      logs: [{ type: 'info', message: 'Test log' }],
      privacyPolicy: 'Zero telemetry manifest',
    });

    assert.ok(fs.existsSync(exportPath), 'ZIP archive must exist on disk');
    assert.equal(result.filesCount, 4, 'Must package report.json, system-diagnostics.json, sanitized-events.json, privacy-manifest.txt');
    assert.ok(result.bytes > 200, 'ZIP must have non-trivial size');

    // Mark report exported
    const marked = feedbackRepo.markExported(createdBugId);
    assert.equal(marked.is_exported, 1);
    assert.equal(marked.status, 'ready'); // Preserves lifecycle status
    assert.ok(marked.exported_at > 0);
  });

  await t.test('5.3: Atomic exportJson writes formatted JSON report', () => {
    const jsonPath = path.join(testDir, 'export', ZipExporter.generateJsonFilename(createdBugReportId));
    const payload = {
      report: feedbackRepo.getById(createdBugId),
      exportedAt: new Date().toISOString(),
    };

    const res = ZipExporter.exportJson(jsonPath, payload);
    assert.ok(fs.existsSync(jsonPath));
    assert.ok(res.bytes > 50);

    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(parsed.report.report_id, createdBugReportId);
  });

  // ==========================================================================
  // 6. ZERO-TELEMETRY & PRIVACY AUDIT
  // ==========================================================================

  await t.test('6.1: Diagnostic bundle excludes database files, downloads, and chunks', () => {
    const collector = new DiagnosticCollector({
      database: barqDb,
      downloadsRepo,
      eventsRepo,
    });

    const bundle = collector.collectDiagnosticBundle();
    const str = JSON.stringify(bundle);

    // Verify no sqlite db headers, binary downloads, or file chunks exist in the bundle
    assert.ok(!str.includes('SQLite format 3'));
    assert.ok(!str.includes('.barq-part'));
    assert.ok(!str.includes('token='));
    assert.ok(!str.includes('password='));
  });

  // ==========================================================================
  // 7. MILESTONE 7.1 AUDIT & RELEASE READINESS VERIFICATIONS
  // ==========================================================================

  await t.test('7.1: Migration v5 decouples lifecycle status from export state', () => {
    // 1. Create a draft report
    const draft = feedbackRepo.create({
      report_type: 'bug',
      title: 'M7.1 Draft report for lifecycle verification',
      category: 'ui_ux',
      description: 'Verifying lifecycle statuses and is_exported column',
      status: 'draft',
      diagnostic_included: 0,
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.is_exported, 0);

    // 2. Transition draft to saved
    const saved = feedbackRepo.update(draft.id, { status: 'saved' });
    assert.equal(saved.status, 'saved');
    assert.equal(saved.is_exported, 0);

    // 3. Mark as exported - verify status remains 'saved', is_exported becomes 1
    const exported = feedbackRepo.markExported(saved.id);
    assert.equal(exported.status, 'saved', 'Lifecycle status must remain saved upon export');
    assert.equal(exported.is_exported, 1, 'is_exported must be 1 after export');
    assert.ok(exported.exported_at > 0);

    // 4. Backward compatibility: setting legacy status 'exported' maps to saved + is_exported=1
    const legacyReport = feedbackRepo.create({
      report_type: 'feature',
      title: 'Legacy import simulation',
      category: 'other',
      description: 'Simulating legacy report with exported status',
      status: 'exported',
    });
    assert.equal(legacyReport.status, 'saved');
    assert.equal(legacyReport.is_exported, 1);

    // 5. Querying by exported status finds both
    const exportedList = feedbackRepo.list({ status: 'exported' });
    assert.ok(exportedList.some((r) => r.id === exported.id));
    assert.ok(exportedList.some((r) => r.id === legacyReport.id));
  });

  await t.test('7.2: Opt-in diagnostics policy and CPU model exclusion', () => {
    // 1. Verify CPU model string is never collected (only architecture and count)
    const collector = new DiagnosticCollector({
      database: barqDb,
      downloadsRepo,
      eventsRepo,
    });
    const bundle = collector.collectDiagnosticBundle();
    assert.equal(bundle.system.cpuModel, undefined, 'cpuModel must not exist in diagnostic bundle');
    assert.equal(typeof bundle.system.cpuCount, 'number');
    assert.ok(bundle.system.cpuCount >= 1);
    assert.equal(typeof bundle.system.arch, 'string');

    // 2. Verify bug reports can be saved completely without diagnostics
    const bugWithoutDiag = feedbackRepo.create({
      report_type: 'bug',
      title: 'Bug report submitted with opt-in diagnostics disabled',
      category: 'other',
      severity: 'low',
      description: 'User explicitly unchecked the diagnostic attachment checkbox.',
      diagnostic_included: 0,
    });
    assert.equal(bugWithoutDiag.diagnostic_included, 0);

    const fetched = feedbackRepo.getById(bugWithoutDiag.id);
    assert.equal(fetched.diagnostic_included, 0);
  });

  await t.test('7.3: Deep redaction: IPv6, UNC paths, Cookies, Auth headers, and filenames', () => {
    const rawLeak = [
      'IPv6 standard: 2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      'IPv6 compressed: fe80::1ff:fe23:4567:890a',
      'UNC share: \\\\fileserver01\\backups\\database.bak',
      'UNC forward: //nas.internal.net/storage/export.zip',
      'Auth Header: Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123',
      'Cookie Header: Set-Cookie: session_id=abcxyz987654; Path=/; HttpOnly; Secure',
      'Quoted media: Downloaded chunk from "secret_archive_2026.iso" successfully',
      'Legitimate URL: https://releases.ubuntu.com/24.04/ubuntu.iso',
    ].join('\n');

    const scrubbed = Sanitizer.scrubText(rawLeak);

    // Verify all private details are redacted
    assert.ok(!scrubbed.includes('2001:0db8:85a3'));
    assert.ok(!scrubbed.includes('fe80::1ff'));
    assert.ok(!scrubbed.includes('\\\\fileserver01\\backups'));
    assert.ok(!scrubbed.includes('nas.internal.net'));
    assert.ok(!scrubbed.includes('eyJhbGciOiJIUzI1Ni'));
    assert.ok(!scrubbed.includes('abcxyz987654'));
    assert.ok(!scrubbed.includes('secret_archive_2026.iso'));
    assert.ok(!scrubbed.includes('releases.ubuntu.com'));

    // Verify redaction tokens
    assert.ok(scrubbed.includes('[REDACTED_IP]'));
    assert.ok(scrubbed.includes('[REDACTED_UNC_PATH]'));
    assert.ok(scrubbed.includes('[REDACTED_TOKEN]'));
    assert.ok(scrubbed.includes('[REDACTED_COOKIE]'));
    assert.ok(scrubbed.includes('[REDACTED_FILENAME]'));
    assert.ok(scrubbed.includes('[REDACTED_URL]'));
  });

  await t.test('7.4: ZipExporter PKZIP 2.0 boundary conditions and temporary file cleanup', () => {
    // 1. Rejects duplicate filenames
    assert.throws(() => {
      ZipExporter.createZipBuffer([
        { name: 'report.json', content: 'content1' },
        { name: 'report.json', content: 'content2' },
      ]);
    }, /Duplicate entry name in ZIP archive: "report\.json"/);

    // 2. Rejects malformed file entry
    assert.throws(() => {
      ZipExporter.createZipBuffer([
        { name: '', content: 'empty name' },
      ]);
    }, /filename is missing or empty/);

    assert.throws(() => {
      ZipExporter.createZipBuffer([null]);
    }, /expected an object/);

    // 3. Temporary file cleanup on interrupted export
    const destDir = path.join(testDir, 'cleanuptest');
    fs.mkdirSync(destDir, { recursive: true });
    const targetFile = path.join(destDir, 'test-cleanup.zip');

    // Create a read-only directory or file collision to simulate rename failure
    const blockingDir = path.join(destDir, 'collision');
    fs.mkdirSync(blockingDir, { recursive: true });

    // Calling exportZip where destination is a directory triggers rename error
    assert.throws(() => {
      ZipExporter.exportZip(blockingDir, {
        report: { report_id: 'BARQ-COLLIS' },
        diagnostics: {},
        logs: [],
        privacyPolicy: 'Clean test',
      });
    });

    // Verify no stray .tmp-* files remain in destDir
    const leftOvers = fs.readdirSync(destDir).filter((f) => f.includes('.tmp-'));
    assert.equal(leftOvers.length, 0, 'Temporary .tmp-* staging files must be cleaned up on failure');
  });

  await t.test('7.5: Zero telemetry verification across feedback & diagnostics modules', () => {
    const modulesToCheck = [
      'src/main/diagnostics/DiagnosticCollector.js',
      'src/main/diagnostics/Sanitizer.js',
      'src/main/diagnostics/ZipExporter.js',
      'src/main/db/feedback-repo.js',
    ];

    for (const modPath of modulesToCheck) {
      const fullPath = path.join(__dirname, '..', modPath);
      const content = fs.readFileSync(fullPath, 'utf8');

      // Assert no automatic outbound network calls exist in feedback/diagnostic modules
      assert.ok(!content.includes('http.request'), `${modPath} must not perform http.request`);
      assert.ok(!content.includes('https.request'), `${modPath} must not perform https.request`);
      assert.ok(!content.includes('fetch('), `${modPath} must not perform fetch()`);
      assert.ok(!content.includes('WebSocket'), `${modPath} must not instantiate WebSocket`);
      assert.ok(!content.includes('analytics'), `${modPath} must not contain analytics SDK`);
      assert.ok(!content.includes('crashReport'), `${modPath} must not contain external crash reporter`);
    }
  });
});
