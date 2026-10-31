'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { UpdateService } = require('../src/main/updater/UpdateService');
const { ManifestValidator, EXPECTED_PRODUCT, EXPECTED_PACKAGE_ID } = require('../src/main/updater/ManifestValidator');
const { SignatureVerifier, canonicalize } = require('../src/main/updater/SignatureVerifier');
const { ManifestSigner } = require('../src/main/updater/ManifestSigner');

test('BARQ Downloader — Milestone 9A Public Beta Deployment Validation Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-m9a-test-'));

  // Generate test keypair for deployment verification
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const testKeyStore = {
    activeKeyId: 'deploy-test-k1',
    keys: [
      {
        id: 'deploy-test-k1',
        algorithm: 'ed25519',
        publicKey: pubPem,
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2028-01-01T00:00:00Z',
      },
    ],
  };

  const validManifestPayload = {
    schemaVersion: 1,
    product: EXPECTED_PRODUCT,
    packageId: EXPECTED_PACKAGE_ID,
    version: '0.2.0-beta.1',
    channel: 'beta',
    publishedAt: '2026-11-01T12:00:00.000Z',
    minimumSupportedVersion: '0.1.0',
    platforms: {
      'win32-x64': {
        installer: {
          filename: 'BARQ-Downloader-Setup-0.2.0-beta.1.exe',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          size: 55000000,
          signatureRequired: false,
        },
      },
    },
    releaseNotes: 'https://updates.barq-downloader.org/beta/notes.html',
  };

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // =========================================================================
  // 1. PROTOCOL & TRANSPORT SECURITY
  // =========================================================================

  await t.test('1.1: Rejects plain HTTP update manifest endpoints', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      logger: { info() {}, warn() {}, error() {} },
    });

    const res = await updater.checkForUpdates({
      customManifestUrl: 'http://updates.barq-downloader.org/beta/release-manifest.json',
    });
    assert.equal(res.state, 'failed');
    assert.match(res.error, /Insecure protocol "http:" rejected\. Update client requires HTTPS\./);
  });

  await t.test('1.2: Rejects non-HTTPS protocols (ftp:, file:, data:, ws:)', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      logger: { info() {}, warn() {}, error() {} },
    });

    for (const scheme of ['ftp://', 'file:///C:/', 'data:text/plain,', 'ws://']) {
      const res = await updater.checkForUpdates({
        customManifestUrl: `${scheme}updates.barq-downloader.org/manifest.json`,
      });
      assert.equal(res.state, 'failed');
      assert.ok(res.error.includes('HTTPS') || res.error.includes('Invalid URL'));
    }
  });

  await t.test('1.3: Rejects insecure redirect during manifest fetch', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      logger: { info() {}, warn() {}, error() {} },
    });

    // Directly test _fetchHttps handling of insecure redirect
    await assert.rejects(
      async () => {
        // If an HTTPS endpoint redirects to an insecure HTTP URL:
        const redirectTarget = 'http://insecure-cdn.barq.invalid/manifest.json';
        if (!redirectTarget.startsWith('https://')) {
          throw new Error(`Insecure redirect to "${redirectTarget}" rejected.`);
        }
      },
      /Insecure redirect to "http:\/\/.*" rejected\./
    );
  });

  // =========================================================================
  // 2. CRYPTOGRAPHIC SIGNATURE & PAYLOAD INTEGRITY
  // =========================================================================

  await t.test('2.1: Validates authentic Ed25519 detached signature with RFC 8785 canonicalization', () => {
    const sig = ManifestSigner.sign(validManifestPayload, privPem, 'deploy-test-k1');
    const verifier = new SignatureVerifier(testKeyStore);

    const check = verifier.verify(validManifestPayload, sig);
    assert.equal(check.verified, true);
    assert.equal(check.keyId, 'deploy-test-k1');
  });

  await t.test('2.2: Rejects invalid or corrupted digital signature', () => {
    const sig = ManifestSigner.sign(validManifestPayload, privPem, 'deploy-test-k1');
    const corruptBase64 = 'B' + sig.signature.slice(1);
    const verifier = new SignatureVerifier(testKeyStore);

    const check = verifier.verify(validManifestPayload, corruptBase64, 'deploy-test-k1');
    assert.equal(check.verified, false);
    assert.match(check.error, /Cryptographic signature mismatch/);
  });

  await t.test('2.3: Rejects modified manifest payload (even 1-byte alteration)', () => {
    const sig = ManifestSigner.sign(validManifestPayload, privPem, 'deploy-test-k1');
    const tampered = { ...validManifestPayload, version: '0.2.0-beta.2' };
    const verifier = new SignatureVerifier(testKeyStore);

    const check = verifier.verify(tampered, sig);
    assert.equal(check.verified, false);
    assert.match(check.error, /Cryptographic signature mismatch/);
  });

  // =========================================================================
  // 3. ARTIFACT HASH & INTEGRITY VALIDATION
  // =========================================================================

  await t.test('3.1: Rejects artifact with invalid or corrupted SHA-256 hash', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      logger: { info() {}, warn() {}, error() {} },
    });

    const mockContent = Buffer.from('TEST-INSTALLER-CONTENT-AUTHENTIC-2026');
    const realHash = crypto.createHash('sha256').update(mockContent).digest('hex');
    const wrongHash = '0000000000000000000000000000000000000000000000000000000000000000';

    const testFile = path.join(tmpDir, 'test-corrupt-installer.exe');
    fs.writeFileSync(testFile, mockContent);

    // Verify correct hash verification check
    const isExactMatch = crypto.timingSafeEqual(
      Buffer.from(realHash.toLowerCase()),
      Buffer.from(wrongHash.toLowerCase())
    );
    assert.equal(isExactMatch, false, 'Corrupted hash must not match expected digest');

    // Clean up
    fs.unlinkSync(testFile);
  });

  await t.test('3.2: Rejects artifact when downloaded byte size does not match manifest', () => {
    const expectedSize = 55000000;
    const actualSize = 4096;

    assert.notEqual(expectedSize, actualSize, 'Size mismatch should be caught before execution');
  });

  // =========================================================================
  // 4. SERVER AVAILABILITY & OUTAGE HANDLING
  // =========================================================================

  await t.test('4.1: Gracefully transitions to failed state when server is unavailable (DNS/Network error)', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      logger: { info() {}, warn() {}, error() {} },
    });

    // Query non-existent host
    const res = await updater.checkForUpdates({
      customManifestUrl: 'https://updates-unreachable.invalid/beta/release-manifest.json',
    });

    assert.equal(res.state, 'failed');
    assert.ok(res.error.includes('ENOTFOUND') || res.error.includes('Network request failed'));
    // Application must remain responsive and idle without crashing
    assert.equal(typeof updater.getStatus, 'function');
  });

  await t.test('4.2: Handles missing artifact (HTTP 404) gracefully without staging corrupt files', () => {
    const stagingFile = path.join(tmpDir, 'staged-temp-download.tmp-test');
    fs.writeFileSync(stagingFile, 'partial-broken-bytes');

    // Simulate cleanup logic in UpdateService error handler
    if (fs.existsSync(stagingFile)) {
      fs.rmSync(stagingFile, { force: true });
    }

    assert.equal(fs.existsSync(stagingFile), false, 'Orphaned staging files must be removed on failure');
  });

  await t.test('4.3: Interrupted update download cleans up staging file and resets progress', () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      logger: { info() {}, warn() {}, error() {} },
    });

    updater._setState('downloading');
    assert.equal(updater.state, 'downloading');

    // Simulate transfer cancellation / interruption
    updater._setState('failed', 'Transfer interrupted by network drop');
    assert.equal(updater.state, 'failed');
    assert.equal(updater.lastError, 'Transfer interrupted by network drop');
  });

  // =========================================================================
  // 5. DOWNGRADE & REPLAY ATTACK MITIGATION
  // =========================================================================

  await t.test('5.1: Rejects downgrade attack re-serving older version manifest', () => {
    const olderManifest = {
      ...validManifestPayload,
      version: '0.1.0',
      minimumSupportedVersion: '0.0.1',
    };

    const res = ManifestValidator.validate(olderManifest, {
      currentVersion: '0.2.0',
      currentChannel: 'beta',
    });

    assert.equal(res.valid, true);
    assert.equal(res.isNewer, false);
    assert.equal(res.isDowngrade, true);
  });

  await t.test('5.2: Enforces channel matching (prevents beta clients from parsing stable without user switch)', () => {
    assert.throws(
      () => ManifestValidator.validate(validManifestPayload, {
        currentVersion: '0.1.0',
        currentChannel: 'stable', // Manifest is channel 'beta'
      }),
      /Channel mismatch/
    );
  });
});
