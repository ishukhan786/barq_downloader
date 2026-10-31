'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const { Sanitizer } = require('../src/main/diagnostics/Sanitizer');
const { ZipExporter } = require('../src/main/diagnostics/ZipExporter');

function makeTempDir(prefix) {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('BARQ Downloader — Milestone 7.1 Advanced Privacy Edge-Case Test Suite', async (t) => {
  const testDir = makeTempDir('barq-privacy-edge-');

  test.after(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  // Synthetic Secret Tokens used across test cases
  const SECRETS = Object.freeze({
    rawUrl: 'https://cdn.private-internal.net:8443/auth/download.pkg?token=TOP_SECRET_HEX_987654321',
    encodedUrl: 'https://downloads.example.org/get?file=confidential%20doc.pdf&sig=a%2Bb%3D%3D&user=admin%40corp.com',
    authBearer: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.SECRET_PAYLOAD_HASH',
    basicAuth: 'Basic dXNlcm5hbWU6c3VwZXJfc2VjcmV0X3Bhc3N3b3JkXzEyMw==',
    cookieVal: 'session_token=CONFIDENTIAL_COOKIE_ABC123; Path=/; Secure; HttpOnly',
    ipv4Public: '198.51.100.42:8443',
    ipv6Bracketed: '[2001:0db8:85a3::8a2e:0370:7334]:8080',
    ipv4Mapped: '::ffff:192.0.2.128:443',
    ipv4MappedBracketed: '[::ffff:198.51.100.42]:8080',
    uncMixed: '\\\\nas01.internal/backups\\subfolder/confidential.db',
    uncRepeated: '\\\\server\\\\share\\\\file.bin',
    uncSpaces: '\\\\storage01\\Personal Share (Confidential)\\financial_2026.xlsx',
    uncAdmin: '\\\\corp-dc01\\c$\\Windows\\System32\\backup.bak',
    driveDBack: 'D:\\UserFiles\\PrivateDownloads\\confidential_backup.iso',
    driveDFwd: 'D:/UserFiles/PrivateDownloads/confidential_backup.iso',
    driveE: 'E:\\Projects\\EnterpriseCore\\proprietary_source.tar.gz',
    driveZ: 'Z:/MountedShares/Engineering/schematic.pdf',
    unicodeFn: 'مستندات_محرمة_2026.pdf',
    unicodeFnUrdu: 'برق_ڈاؤنلوڈر_سیٹ_اپ.zip',
    spacesFn: 'My Secret Project - (Final Version) #2 [2026].tar.gz',
    unquotedFn: 'confidential_contract_v2.iso',
    noExtFn: 'database_binary_dump',
  });

  // ==========================================================================
  // 1. FILENAMES (WITHOUT EXTENSION, UNQUOTED, UNICODE, SPACES & PUNCTUATION)
  // ==========================================================================

  await t.test('1.1: Redacts filenames without extensions when provided in log context', () => {
    const raw = `Saved target file: ${SECRETS.noExtFn} to disk. Finished file: ${SECRETS.noExtFn}.`;
    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes(SECRETS.noExtFn), 'Filenames without extension must be redacted');
    assert.ok(scrubbed.includes('[REDACTED_FILENAME]'));
    assert.ok(scrubbed.startsWith('Saved target file: [REDACTED_FILENAME] to disk.'), 'Preserves sentence structure');
  });

  await t.test('1.2: Redacts unquoted filenames with common extensions', () => {
    const raw = `Downloaded file: ${SECRETS.unquotedFn} successfully in 4.2 seconds.`;
    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes(SECRETS.unquotedFn), 'Unquoted filenames must be redacted');
    assert.ok(scrubbed.includes('[REDACTED_FILENAME]'));
    assert.ok(scrubbed.includes('successfully in 4.2 seconds.'), 'Preserves log timing and completion context');
  });

  await t.test('1.3: Redacts Unicode filenames (Arabic, Urdu, Cyrillic)', () => {
    const raw = `Finished writing "${SECRETS.unicodeFn}" and "${SECRETS.unicodeFnUrdu}".`;
    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes(SECRETS.unicodeFn), 'Arabic Unicode filename must not leak');
    assert.ok(!scrubbed.includes(SECRETS.unicodeFnUrdu), 'Urdu Unicode filename must not leak');
    assert.ok(scrubbed.includes('"[REDACTED_FILENAME]"'));
  });

  await t.test('1.4: Redacts filenames containing spaces, brackets, hashes, and punctuation', () => {
    const raw = `Extracted archive chunk for "${SECRETS.spacesFn}".`;
    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('Final Version'), 'Title text in filename must be redacted');
    assert.ok(!scrubbed.includes(SECRETS.spacesFn), 'Full filename with spaces/punctuation must be redacted');
    assert.ok(scrubbed.includes('"[REDACTED_FILENAME]"'));
  });

  // ==========================================================================
  // 2. NETWORK ADDRESSES (PORTS, MAPPED IPV6, UNUSUAL UNC SEPARATORS)
  // ==========================================================================

  await t.test('2.1: Redacts IPv4 and IPv6 with custom port numbers while preserving loopback', () => {
    const raw = [
      `Remote peer IPv4: ${SECRETS.ipv4Public}`,
      `Remote peer IPv6: ${SECRETS.ipv6Bracketed}`,
      'Local proxy IPv4: 127.0.0.1:8080 (loopback preserved)',
      'Local proxy IPv6: [::1]:80 (loopback preserved)',
    ].join('\n');

    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('198.51.100.42'), 'Public IPv4 must be redacted');
    assert.ok(!scrubbed.includes('8443'), 'Public IPv4 port must be redacted with the IP');
    assert.ok(!scrubbed.includes('2001:0db8:85a3'), 'Public IPv6 must be redacted');
    assert.ok(scrubbed.includes('127.0.0.1:8080'), '127.0.0.1 loopback must be preserved');
    assert.ok(scrubbed.includes('[::1]:80'), '[::1] IPv6 loopback must be preserved');
  });

  await t.test('2.2: Redacts IPv4-mapped IPv6 addresses (with and without brackets/ports)', () => {
    const raw = `Mapped address 1: ${SECRETS.ipv4Mapped}; Mapped address 2: ${SECRETS.ipv4MappedBracketed}`;
    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('::ffff:'), 'IPv4-mapped prefix must be redacted');
    assert.ok(!scrubbed.includes('192.0.2.128'), 'Mapped IPv4 octets must be redacted');
    assert.ok(!scrubbed.includes('198.51.100.42'), 'Mapped IPv4 octets in brackets must be redacted');
    assert.ok(scrubbed.includes('[REDACTED_IP]'));
  });

  await t.test('2.3: Redacts UNC paths with mixed slashes, spaces, repeated slashes, and admin shares', () => {
    const raw = [
      `Mixed: ${SECRETS.uncMixed}`,
      `Repeated: ${SECRETS.uncRepeated}`,
      `Spaces: ${SECRETS.uncSpaces}`,
      `Admin: ${SECRETS.uncAdmin}`,
    ].join('\n');

    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('nas01.internal'), 'UNC server name must be redacted');
    assert.ok(!scrubbed.includes('storage01'), 'UNC share name must be redacted');
    assert.ok(!scrubbed.includes('corp-dc01'), 'Admin UNC server must be redacted');
    assert.ok(!scrubbed.includes('financial_2026'), 'UNC filename must be redacted');
    assert.ok(scrubbed.includes('[REDACTED_UNC_PATH]'));
  });

  // ==========================================================================
  // 3. FILE SYSTEM PATHS & DRIVE LETTERS
  // ==========================================================================

  await t.test('3.1: Redacts Windows paths across drives (D:, E:, Z:) with forward and backward slashes', () => {
    const raw = [
      `Drive D backslash: ${SECRETS.driveDBack}`,
      `Drive D forward-slash: ${SECRETS.driveDFwd}`,
      `Drive E backslash: ${SECRETS.driveE}`,
      `Drive Z forward-slash: ${SECRETS.driveZ}`,
    ].join('\n');

    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('confidential_backup.iso'), 'Drive D filenames must be redacted');
    assert.ok(!scrubbed.includes('UserFiles'), 'Drive D directories must be redacted');
    assert.ok(!scrubbed.includes('EnterpriseCore'), 'Drive E directories must be redacted');
    assert.ok(!scrubbed.includes('MountedShares'), 'Drive Z directories must be redacted');
    assert.ok(scrubbed.includes('[REDACTED_PATH]'));
  });

  // ==========================================================================
  // 4. AUTHENTICATION, HEADERS, AND ENCODED URLS
  // ==========================================================================

  await t.test('4.1: Redacts Basic authentication credentials (in headers and standalone)', () => {
    const raw = [
      `Header: Authorization: ${SECRETS.basicAuth}`,
      `Standalone token found: ${SECRETS.basicAuth}`,
      'URL with credentials: https://user:super_secret_pw@internal.bank.com:9443/vault.zip',
    ].join('\n');

    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('dXNlcm5hbWU'), 'Base64 basic auth string must be redacted');
    assert.ok(!scrubbed.includes('super_secret_pw'), 'Inline URL credentials must be redacted');
    assert.ok(scrubbed.includes('Authorization: [REDACTED_TOKEN]'));
    assert.ok(scrubbed.includes('Basic [REDACTED_TOKEN]'));
    assert.ok(scrubbed.includes('[REDACTED_URL]'));
  });

  await t.test('4.2: Redacts URLs with URL-encoded query parameters and signatures', () => {
    const raw = `Failed to fetch payload from ${SECRETS.encodedUrl}. Operation timed out.`;
    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('downloads.example.org'), 'Domain must be redacted');
    assert.ok(!scrubbed.includes('confidential%20doc.pdf'), 'Encoded filename must be redacted');
    assert.ok(!scrubbed.includes('admin%40corp.com'), 'Encoded user must be redacted');
    assert.ok(scrubbed.includes('[REDACTED_URL]'));
    assert.ok(scrubbed.includes('Operation timed out.'), 'Preserves non-sensitive error description');
  });

  await t.test('4.3: Handles case variations in authorization and cookie headers', () => {
    const raw = [
      `authorization: ${SECRETS.authBearer}`,
      `AUTHORIZATION: ${SECRETS.authBearer}`,
      `AuthoriZation: ${SECRETS.basicAuth}`,
      `set-cookie: ${SECRETS.cookieVal}`,
      `SET-COOKIE: ${SECRETS.cookieVal}`,
      `cookie: ${SECRETS.cookieVal}`,
      `COOKIE: ${SECRETS.cookieVal}`,
    ].join('\n');

    const scrubbed = Sanitizer.scrubText(raw);

    assert.ok(!scrubbed.includes('SECRET_PAYLOAD_HASH'), 'Bearer token payload must be redacted regardless of header casing');
    assert.ok(!scrubbed.includes('CONFIDENTIAL_COOKIE_ABC123'), 'Cookie token must be redacted regardless of header casing');
    assert.ok(scrubbed.includes('Authorization: [REDACTED_TOKEN]'));
    assert.ok(scrubbed.includes('Cookie: [REDACTED_COOKIE]'));
  });

  // ==========================================================================
  // 5. IMMUTABILITY, NESTED ARRAYS, AND ERROR OBJECTS
  // ==========================================================================

  await t.test('5.1: Preserves input object immutability and traverses nested arrays and Errors', () => {
    const rawError = new Error(`Connection failed to ${SECRETS.rawUrl}: 401 Unauthorized with ${SECRETS.authBearer}`);
    const originalInput = Object.freeze({
      meta: {
        timestamp: 1793478000000,
        tags: ['network', 'retry-loop'],
      },
      diagnosticChains: [
        [
          {
            level: 'warn',
            endpoint: SECRETS.rawUrl,
            error: rawError,
            attempts: [
              { peer: SECRETS.ipv4Public, status: 'rejected' },
              { peer: SECRETS.ipv6Bracketed, status: 'timeout' },
            ],
          },
        ],
      ],
      downloadContext: {
        targetFile: SECRETS.spacesFn,
        storagePath: SECRETS.driveDBack,
      },
    });

    // Execute sanitization
    const sanitized = Sanitizer.scrubObject(originalInput);

    // 1. Verify original input was NOT mutated
    assert.equal(originalInput.diagnosticChains[0][0].endpoint, SECRETS.rawUrl, 'Original input must not be mutated');
    assert.equal(originalInput.downloadContext.storagePath, SECRETS.driveDBack, 'Original path must not be mutated');

    // 2. Verify sanitized result contains ZERO secrets
    const serializedSanitized = JSON.stringify(sanitized);
    assert.ok(!serializedSanitized.includes('TOP_SECRET_HEX_987654321'), 'Secret URL token must not exist in sanitized object');
    assert.ok(!serializedSanitized.includes('SECRET_PAYLOAD_HASH'), 'Bearer token must not exist in sanitized object');
    assert.ok(!serializedSanitized.includes('198.51.100.42'), 'IPv4 must not exist in sanitized object');
    assert.ok(!serializedSanitized.includes('2001:0db8:85a3'), 'IPv6 must not exist in sanitized object');
    assert.ok(!serializedSanitized.includes('confidential_backup.iso'), 'Disk path must not exist in sanitized object');
    assert.ok(!serializedSanitized.includes('Final Version'), 'Target filename must not exist in sanitized object');

    // 3. Verify Error instance was properly scrubbed
    const scrubbedErr = sanitized.diagnosticChains[0][0].error;
    assert.ok(scrubbedErr.message.includes('[REDACTED_URL]'), 'Error message must have URL redacted');
    assert.ok(scrubbedErr.message.includes('[REDACTED_TOKEN]'), 'Error message must have Bearer token redacted');
    assert.ok(!scrubbedErr.message.includes('TOP_SECRET'), 'Raw secret must not leak in error message');

    // 4. Verify safe metadata was preserved intact
    assert.equal(sanitized.meta.timestamp, 1793478000000);
    assert.equal(sanitized.meta.tags[0], 'network');
    assert.equal(sanitized.meta.tags[1], 'retry-loop');
  });

  // ==========================================================================
  // 6. EXPORT VERIFICATION (ACTUAL ARCHIVE GENERATION & DISK INSPECTION)
  // ==========================================================================

  await t.test('6.1: Generates real diagnostic JSON and ZIP archives, inspecting all entries for leaks', () => {
    const rawReport = {
      report_id: 'BARQ-TEST99',
      report_type: 'bug',
      title: 'Crash during transfer from internal server',
      category: 'download_failure',
      severity: 'high',
      description: `Tried downloading ${SECRETS.rawUrl} to ${SECRETS.driveDBack} via proxy ${SECRETS.ipv4Public}`,
      reproduction_steps: `1. Connect to ${SECRETS.ipv6Bracketed}\n2. Send ${SECRETS.authBearer}`,
      expected_behavior: 'Should complete download',
      actual_behavior: `Got ${SECRETS.basicAuth} rejection error`,
      status: 'saved',
      is_exported: 0,
      diagnostic_included: 1,
      created_at: Date.now(),
    };

    const rawDiagnostics = {
      system: {
        platform: 'win32',
        arch: 'x64',
        cpuCount: 16,
        totalMemoryMB: 32768,
      },
      networkTrace: [
        { host: SECRETS.ipv4Public, note: `Mirrored on ${SECRETS.uncMixed}` },
        { host: SECRETS.ipv6Bracketed, note: `Set-Cookie: ${SECRETS.cookieVal}` },
      ],
      recentFiles: [
        SECRETS.unicodeFn,
        SECRETS.unicodeFnUrdu,
        SECRETS.spacesFn,
      ],
    };

    const rawLogs = [
      { id: 1, level: 'info', message: `Initiating connection to ${SECRETS.rawUrl}` },
      { id: 2, level: 'error', message: `Failed to write file: ${SECRETS.unquotedFn} to ${SECRETS.driveDFwd}` },
      { id: 3, level: 'info', message: `Target file "${SECRETS.noExtFn}" was processed` },
    ];

    // 1. Export atomic JSON report
    const jsonExportPath = path.join(testDir, ZipExporter.generateJsonFilename(rawReport.report_id));
    const sanitizedReport = Sanitizer.scrubObject(rawReport);
    ZipExporter.exportJson(jsonExportPath, { report: sanitizedReport, exportedAt: new Date().toISOString() });

    assert.ok(fs.existsSync(jsonExportPath), 'JSON export file must exist');
    const jsonContent = fs.readFileSync(jsonExportPath, 'utf8');

    // 2. Export atomic full ZIP package
    const zipExportPath = path.join(testDir, ZipExporter.generateZipFilename());
    const zipResult = ZipExporter.exportZip(zipExportPath, {
      report: sanitizedReport,
      diagnostics: Sanitizer.scrubObject(rawDiagnostics),
      logs: rawLogs.map((l) => ({ ...l, message: Sanitizer.scrubText(l.message) })),
      privacyPolicy: 'Zero Telemetry & Diagnostics Privacy Guarantee: All logs are scrubbed locally before export.',
    });

    assert.ok(fs.existsSync(zipExportPath), 'ZIP archive file must exist');
    assert.equal(zipResult.filesCount, 4);

    // 3. Inspect every entry inside the generated ZIP archive
    const zipBuffer = fs.readFileSync(zipExportPath);
    let offset = 0;
    const extractedEntries = new Map();

    while (offset < zipBuffer.length) {
      const sig = zipBuffer.readUInt32LE(offset);
      if (sig === 0x04034b50) {
        // Local file header
        const compMethod = zipBuffer.readUInt16LE(offset + 8);
        const compSize = zipBuffer.readUInt32LE(offset + 18);
        const uncompSize = zipBuffer.readUInt32LE(offset + 22);
        const nameLen = zipBuffer.readUInt16LE(offset + 26);
        const extraLen = zipBuffer.readUInt16LE(offset + 28);
        const name = zipBuffer.toString('utf8', offset + 30, offset + 30 + nameLen);
        const dataStart = offset + 30 + nameLen + extraLen;
        const compressedData = zipBuffer.subarray(dataStart, dataStart + compSize);

        let uncompressedData;
        if (compMethod === 8) {
          uncompressedData = zlib.inflateRawSync(compressedData);
        } else {
          uncompressedData = compressedData;
        }

        assert.equal(uncompressedData.length, uncompSize, `Inflated size for ${name} must match header`);
        extractedEntries.set(name, uncompressedData.toString('utf8'));
        offset = dataStart + compSize;
      } else if (sig === 0x02014b50) {
        // Central directory file header
        const nameLen = zipBuffer.readUInt16LE(offset + 28);
        const extraLen = zipBuffer.readUInt16LE(offset + 30);
        const commentLen = zipBuffer.readUInt16LE(offset + 32);
        offset += 46 + nameLen + extraLen + commentLen;
      } else if (sig === 0x06054b50) {
        // End of central directory record
        break;
      } else {
        offset++;
      }
    }

    assert.equal(extractedEntries.size, 4, 'Must extract exactly 4 files from diagnostic archive');
    assert.ok(extractedEntries.has('report.json'));
    assert.ok(extractedEntries.has('system-diagnostics.json'));
    assert.ok(extractedEntries.has('sanitized-events.json'));
    assert.ok(extractedEntries.has('privacy-manifest.txt'));

    // 4. Thoroughly verify NO secrets leaked into ANY extracted file or JSON report
    const allContents = [jsonContent, ...extractedEntries.values()].join('\n---\n');

    for (const [secretKey, secretVal] of Object.entries(SECRETS)) {
      assert.ok(
        !allContents.includes(secretVal),
        `Privacy Violation: Secret key "${secretKey}" was detected inside exported diagnostic files.`
      );
    }

    // 5. Confirm expected sanitization tokens appear across the extracted files
    assert.ok(allContents.includes('[REDACTED_URL]'), 'Must include [REDACTED_URL]');
    assert.ok(allContents.includes('[REDACTED_PATH]'), 'Must include [REDACTED_PATH]');
    assert.ok(allContents.includes('[REDACTED_IP]'), 'Must include [REDACTED_IP]');
    assert.ok(allContents.includes('[REDACTED_TOKEN]'), 'Must include [REDACTED_TOKEN]');
    assert.ok(allContents.includes('[REDACTED_COOKIE]'), 'Must include [REDACTED_COOKIE]');
    assert.ok(allContents.includes('[REDACTED_UNC_PATH]'), 'Must include [REDACTED_UNC_PATH]');
    assert.ok(allContents.includes('[REDACTED_FILENAME]'), 'Must include [REDACTED_FILENAME]');
  });
});
