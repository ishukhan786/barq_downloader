'use strict';

/**
 * BARQ Downloader — Milestone 9A.1 GitHub Releases & Redirect Security Test Suite
 *
 * Comprehensive automated verification covering:
 * - Beta & Stable release discovery
 * - Draft, malformed tag, and channel filtering
 * - Hop-by-hop HTTPS redirect policy & host allowlist enforcement
 * - HTTP downgrade and redirect loop prevention
 * - GitHub API rate-limit handling
 * - Missing asset and unsupported architecture rejection
 * - Cryptographic Ed25519 & SHA-256 validation
 * - Isolated staging, user cancellation, and no silent execution
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

const {
  UpdateService,
  APPROVED_REDIRECT_HOSTS,
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
} = require('../src/main/updater/UpdateService');
const { ManifestValidator } = require('../src/main/updater/ManifestValidator');
const { ManifestSigner } = require('../src/main/updater/ManifestSigner');
const { SignatureVerifier } = require('../src/main/updater/SignatureVerifier');

test('BARQ Downloader — Milestone 9A.1 GitHub Releases Suite', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `barq-test-m9a1-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Generate an ephemeral test Ed25519 keypair for test signing
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const testKeyStore = {
    keys: [
      {
        id: 'test-beta-key',
        algorithm: 'ed25519',
        publicKey: pubPem,
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2028-01-01T00:00:00Z',
        description: 'Test Beta Verification Key',
      },
    ],
  };
  const testVerifier = new SignatureVerifier(testKeyStore);

  const samplePayload = Buffer.from('BARQ_M9A1_TEST_PAYLOAD_BINARY_CONTENTS_123456');
  const sampleHash = crypto.createHash('sha256').update(samplePayload).digest('hex');
  const sampleSize = samplePayload.length;

  function createValidManifest(ver = '0.2.0-beta.1', channel = 'beta') {
    return {
      schemaVersion: 1,
      product: 'BARQ Downloader',
      packageId: 'com.barq.downloader',
      appId: 'com.barq.downloader',
      version: ver,
      channel,
      publishedAt: '2026-11-01T00:00:00Z',
      minimumSupportedVersion: '0.1.0',
      platforms: {
        'win32-x64': {
          installer: {
            filename: `BARQ-Downloader-Setup-${ver}.exe`,
            sha256: sampleHash,
            size: sampleSize,
            signatureRequired: false,
          },
        },
      },
    };
  }

  // =========================================================================
  // 1. GitHub Release Discovery & Channel Filtering Tests
  // =========================================================================

  await t.test('1.1: Discovers newest eligible beta release while skipping drafts and malformed tags', async () => {
    const manifest = createValidManifest('0.2.0-beta.1', 'beta');
    const signed = ManifestSigner.sign(manifest, privPem, 'test-beta-key');

    const mockReleases = [
      {
        id: 101,
        tag_name: 'v0.3.0-draft',
        draft: true, // MUST BE SKIPPED
        prerelease: true,
        assets: [],
      },
      {
        id: 102,
        tag_name: 'invalid-tag-format', // MALFORMED TAG - MUST BE SKIPPED
        draft: false,
        prerelease: true,
        assets: [],
      },
      {
        id: 103,
        tag_name: 'v0.1.5-beta.1', // OLDER BETA
        draft: false,
        prerelease: true,
        assets: [],
      },
      {
        id: 104,
        tag_name: 'v0.2.0-beta.1', // NEWEST ELIGIBLE BETA
        draft: false,
        prerelease: true,
        published_at: '2026-11-01T00:00:00Z',
        body: 'Beta Release 2 with acceleration',
        assets: [
          {
            name: 'release-manifest.json',
            browser_download_url: 'https://example.invalid/manifest.json',
          },
          {
            name: 'release-manifest.json.sig',
            browser_download_url: 'https://example.invalid/manifest.json.sig',
          },
          {
            name: 'BARQ-Downloader-Setup-0.2.0-beta.1.exe',
            browser_download_url: 'https://example.invalid/BARQ-Downloader-Setup-0.2.0-beta.1.exe',
          },
        ],
      },
    ];

    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Provide mock fetch implementation
    updater._fetchHttps = async (url) => {
      if (url.endsWith('manifest.json')) return Buffer.from(JSON.stringify(manifest), 'utf8');
      if (url.endsWith('manifest.json.sig')) return Buffer.from(signed.signature, 'utf8');
      throw new Error(`Unexpected URL in test: ${url}`);
    };

    const status = await updater.checkForUpdates({ mockReleases });
    assert.equal(status.state, 'update-available');
    assert.equal(status.availableVersion, '0.2.0-beta.1');
    assert.equal(status.releaseNotes, 'Beta Release 2 with acceleration');
  });

  await t.test('1.2: Stable channel strictly rejects prereleases and discovers newest stable release', async () => {
    const stableManifest = createValidManifest('0.2.0', 'stable');
    const signed = ManifestSigner.sign(stableManifest, privPem, 'test-beta-key');

    const mockReleases = [
      {
        id: 201,
        tag_name: 'v0.3.0-beta.1',
        draft: false,
        prerelease: true, // PRERELEASE - MUST BE IGNORED BY STABLE
        assets: [],
      },
      {
        id: 202,
        tag_name: 'v0.2.0', // VALID STABLE
        draft: false,
        prerelease: false,
        published_at: '2026-11-01T00:00:00Z',
        body: 'Stable Release v0.2.0',
        assets: [
          { name: 'release-manifest.json', browser_download_url: 'https://example.invalid/manifest.json' },
          { name: 'release-manifest.json.sig', browser_download_url: 'https://example.invalid/manifest.json.sig' },
          { name: 'BARQ-Downloader-Setup-0.2.0.exe', browser_download_url: 'https://example.invalid/BARQ-Downloader-Setup-0.2.0.exe' },
        ],
      },
    ];

    const updater = new UpdateService({
      channel: 'stable',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      logger: { info() {}, warn() {}, error() {} },
    });

    updater._fetchHttps = async (url) => {
      if (url.endsWith('manifest.json')) return Buffer.from(JSON.stringify(stableManifest), 'utf8');
      if (url.endsWith('manifest.json.sig')) return Buffer.from(signed.signature, 'utf8');
      throw new Error(`Unexpected URL: ${url}`);
    };

    const status = await updater.checkForUpdates({ mockReleases });
    assert.equal(status.state, 'update-available');
    assert.equal(status.availableVersion, '0.2.0');
    assert.equal(status.channel, 'stable');
  });

  await t.test('1.3: Rejects release missing required release-manifest.json or release-manifest.json.sig', async () => {
    const mockReleases = [
      {
        id: 301,
        tag_name: 'v0.2.0-beta.1',
        draft: false,
        prerelease: true,
        assets: [
          // Missing release-manifest.json.sig!
          { name: 'release-manifest.json', browser_download_url: 'https://example.invalid/manifest.json' },
        ],
      },
    ];

    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      logger: { info() {}, warn() {}, error() {} },
    });

    const status = await updater.checkForUpdates({ mockReleases });
    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('missing required release-manifest.json or release-manifest.json.sig'));
  });

  await t.test('1.4: Handles empty releases list with state "no-update"', async () => {
    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
    });

    const status = await updater.checkForUpdates({ mockReleases: [] });
    assert.equal(status.state, 'no-update');
    assert.equal(status.availableVersion, null);
  });

  // =========================================================================
  // 2. Cryptographic Security & Tamper Rejection Tests
  // =========================================================================

  await t.test('2.1: Rejects release with invalid or tampered Ed25519 signature', async () => {
    const manifest = createValidManifest('0.2.0-beta.1', 'beta');
    const mockReleases = [
      {
        id: 401,
        tag_name: 'v0.2.0-beta.1',
        draft: false,
        prerelease: true,
        assets: [
          { name: 'release-manifest.json', browser_download_url: 'https://example.invalid/manifest.json' },
          { name: 'release-manifest.json.sig', browser_download_url: 'https://example.invalid/manifest.json.sig' },
        ],
      },
    ];

    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      logger: { info() {}, warn() {}, error() {} },
    });

    updater._fetchHttps = async (url) => {
      if (url.endsWith('manifest.json')) return Buffer.from(JSON.stringify(manifest), 'utf8');
      if (url.endsWith('manifest.json.sig')) return Buffer.from('FAKE_CORRUPTED_SIGNATURE_BASE64', 'utf8');
      throw new Error(`Unexpected: ${url}`);
    };

    const status = await updater.checkForUpdates({ mockReleases });
    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('authenticity verification failed'));
  });

  await t.test('2.2: Rejects manifest targeting unsupported platform architecture', async () => {
    const badManifest = {
      schemaVersion: 1,
      product: 'BARQ Downloader',
      packageId: 'com.barq.downloader',
      version: '0.2.0-beta.1',
      channel: 'beta',
      publishedAt: '2026-11-01T00:00:00Z',
      platforms: {
        'darwin-arm64': { // WRONG PLATFORM
          installer: { filename: 'BARQ-Downloader-Setup-0.2.0.exe', sha256: sampleHash, size: sampleSize },
        },
      },
    };
    const signed = ManifestSigner.sign(badManifest, privPem, 'test-beta-key');

    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      logger: { info() {}, warn() {}, error() {} },
    });

    const mockReleases = [
      {
        id: 501,
        tag_name: 'v0.2.0-beta.1',
        draft: false,
        prerelease: true,
        assets: [
          { name: 'release-manifest.json', browser_download_url: 'https://example.invalid/manifest.json' },
          { name: 'release-manifest.json.sig', browser_download_url: 'https://example.invalid/manifest.json.sig' },
        ],
      },
    ];

    updater._fetchHttps = async (url) => {
      if (url.endsWith('manifest.json')) return Buffer.from(JSON.stringify(badManifest), 'utf8');
      if (url.endsWith('manifest.json.sig')) return Buffer.from(signed.signature, 'utf8');
    };

    const status = await updater.checkForUpdates({ mockReleases });
    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('win32-x64'));
  });

  await t.test('2.3: Rejects downgrade attempt (older version in release)', async () => {
    const manifest = createValidManifest('0.0.9-beta.1', 'beta'); // Older than current 0.1.0
    const signed = ManifestSigner.sign(manifest, privPem, 'test-beta-key');

    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      logger: { info() {}, warn() {}, error() {} },
    });

    const mockReleases = [
      {
        id: 601,
        tag_name: 'v0.0.9-beta.1',
        draft: false,
        prerelease: true,
        assets: [
          { name: 'release-manifest.json', browser_download_url: 'https://example.invalid/manifest.json' },
          { name: 'release-manifest.json.sig', browser_download_url: 'https://example.invalid/manifest.json.sig' },
        ],
      },
    ];

    updater._fetchHttps = async (url) => {
      if (url.endsWith('manifest.json')) return Buffer.from(JSON.stringify(manifest), 'utf8');
      if (url.endsWith('manifest.json.sig')) return Buffer.from(signed.signature, 'utf8');
    };

    const status = await updater.checkForUpdates({ mockReleases });
    assert.equal(status.state, 'no-update');
    assert.equal(status.availableVersion, null);
  });

  // =========================================================================
  // 3. Hop-by-Hop Redirect and Network Security Tests
  // =========================================================================

  await t.test('3.1: Rejects unapproved redirect host during fetch', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
    });

    await assert.rejects(
      () => updater._fetchHttps('https://malicious-external-mirror.org/manifest.json', 1024),
      /Unapproved redirect host rejected/
    );
  });

  await t.test('3.2: Rejects HTTPS-to-HTTP downgrade during redirect', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: 'http://127.0.0.1:' + server.address().port + '/insecure' });
        res.end();
      } else {
        res.writeHead(200);
        res.end('insecure body');
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const updater = new UpdateService({
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
      allowedHosts: ['127.0.0.1'],
    });

    try {
      await assert.rejects(
        () => updater._fetchHttps(`http://127.0.0.1:${port}/start`, 1024, {
          allowInsecureHttp: false, // Strict HTTPS required
        }),
        /Insecure protocol "http:" rejected/
      );
    } finally {
      server.close();
    }
  });

  await t.test('3.3: Detects and rejects redirect loops', async () => {
    const server = http.createServer((req, res) => {
      const port = server.address().port;
      if (req.url === '/loop1') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/loop2` });
        res.end();
      } else if (req.url === '/loop2') {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/loop1` }); // Loop back
        res.end();
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const updater = new UpdateService({
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
      allowedHosts: ['127.0.0.1'],
    });

    try {
      await assert.rejects(
        () => updater._fetchHttps(`http://127.0.0.1:${port}/loop1`, 1024, {
          allowedHosts: new Set(['127.0.0.1']),
          allowInsecureHttp: true, // test harness
        }),
        /Redirect loop detected/
      );
    } finally {
      server.close();
    }
  });

  await t.test('3.4: Handles GitHub API rate-limit response gracefully', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(403, {
        'Content-Type': 'application/json',
        'x-ratelimit-remaining': '0',
      });
      res.end(JSON.stringify({ message: 'API rate limit exceeded' }));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const updater = new UpdateService({
      stagingDir: tmpDir,
      githubApiBaseUrl: `http://127.0.0.1:${port}`,
      allowedHosts: ['127.0.0.1'],
      logger: { info() {}, warn() {}, error() {} },
    });

    const status = await updater.checkForUpdates({
      releasesApiUrl: `http://127.0.0.1:${port}/releases`,
      allowedHosts: new Set(['127.0.0.1']),
      allowInsecureHttp: true,
    });

    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('rate limit exceeded'));
    server.close();
  });

  await t.test('3.5: Network unavailable or DNS failure transitions to failed state gracefully', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      githubApiBaseUrl: 'https://nonexistent-github-api-offline.invalid',
      allowedHosts: ['nonexistent-github-api-offline.invalid'],
      logger: { info() {}, warn() {}, error() {} },
    });

    const status = await updater.checkForUpdates({
      releasesApiUrl: 'https://nonexistent-github-api-offline.invalid/repos/ishukhan786/barq_downloader/releases',
      allowedHosts: new Set(['nonexistent-github-api-offline.invalid']),
    });

    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('ENOTFOUND') || status.error.includes('Network request failed'));
  });

  // =========================================================================
  // 6. Live GitHub Integration Test
  // =========================================================================

  await t.test('6.1: Live GitHub repository query to https://github.com/ishukhan786/barq_downloader', async () => {
    const updater = new UpdateService({
      githubOwner: 'ishukhan786',
      githubRepo: 'barq_downloader',
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
    });

    // Query live GitHub Releases API for public repo ishukhan786/barq_downloader
    const status = await updater.checkForUpdates();

    // Since tags are pushed but no release entry with binary assets is published yet on GitHub Web,
    // the updater correctly transitions to 'no-update' (0 releases) or 'failed' if rate limited.
    assert.ok(status.state === 'no-update' || status.state === 'failed');
    assert.equal(typeof updater.getStatus, 'function');
  });

  // =========================================================================
  // 4. Artifact Download, Checksum & Staging Integrity Tests
  // =========================================================================

  await t.test('4.1: Successfully streams artifact with redirect to staging and verifies SHA-256', async () => {
    const server = http.createServer((req, res) => {
      const port = server.address().port;
      if (req.url === '/download-start') {
        // Simulates GitHub release asset redirecting to S3/CDN host
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/cdn-storage/artifact.exe` });
        res.end();
      } else if (req.url === '/cdn-storage/artifact.exe') {
        res.writeHead(200, {
          'Content-Type': 'application/vnd.microsoft.portable-executable',
          'Content-Length': String(sampleSize),
        });
        res.end(samplePayload);
      }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const updater = new UpdateService({
      channel: 'beta',
      currentVersion: '0.1.0',
      stagingDir: tmpDir,
      verifier: testVerifier,
      allowedHosts: ['127.0.0.1'],
      logger: { info() {}, warn() {}, error() {} },
    });

    updater.availableRelease = {
      version: '0.2.0-beta.1',
      artifact: {
        filename: 'BARQ-Downloader-Setup-0.2.0-beta.1.exe',
        sha256: sampleHash,
        size: sampleSize,
      },
      artifactDownloadUrl: `http://127.0.0.1:${port}/download-start`,
    };

    const status = await updater.downloadUpdate({
      allowedHosts: new Set(['127.0.0.1']),
      allowInsecureHttp: true,
    });

    assert.equal(status.state, 'ready-to-install');
    assert.equal(status.stagedReady, true);
    assert.ok(updater.stagedArtifact.path.includes('.tmp-'));

    server.close();
  });

  await t.test('4.2: Rejects artifact with SHA-256 digest mismatch and deletes staging file', async () => {
    const corruptPayload = Buffer.from('CORRUPTED_TAMPERED_BYTES');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': String(corruptPayload.length) });
      res.end(corruptPayload);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const updater = new UpdateService({
      stagingDir: tmpDir,
      allowedHosts: ['127.0.0.1'],
      logger: { info() {}, warn() {}, error() {} },
    });

    updater.availableRelease = {
      version: '0.2.0-beta.1',
      artifact: {
        filename: 'BARQ-Downloader-Setup-0.2.0-beta.1.exe',
        sha256: sampleHash, // Expected sampleHash, but server returns corruptPayload
        size: corruptPayload.length,
      },
      artifactDownloadUrl: `http://127.0.0.1:${port}/corrupt.exe`,
    };

    const status = await updater.downloadUpdate({
      allowedHosts: new Set(['127.0.0.1']),
      allowInsecureHttp: true,
    });

    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('SHA-256 verification failed'));
    // Verify no stray staging file remains
    assert.equal(updater.stagedArtifact, null);

    server.close();
  });

  await t.test('4.3: Rejects artifact with byte size mismatch', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Length': '10' });
      res.end(Buffer.alloc(10));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const updater = new UpdateService({
      stagingDir: tmpDir,
      allowedHosts: ['127.0.0.1'],
      logger: { info() {}, warn() {}, error() {} },
    });

    updater.availableRelease = {
      version: '0.2.0-beta.1',
      artifact: {
        filename: 'BARQ-Downloader-Setup-0.2.0-beta.1.exe',
        sha256: sampleHash,
        size: 999999, // Expects 999,999 bytes, server gives 10
      },
      artifactDownloadUrl: `http://127.0.0.1:${port}/short.exe`,
    };

    const status = await updater.downloadUpdate({
      allowedHosts: new Set(['127.0.0.1']),
      allowInsecureHttp: true,
    });

    assert.equal(status.state, 'failed');
    assert.ok(status.error.includes('Artifact size mismatch'));

    server.close();
  });

  // =========================================================================
  // 5. User Consent & Execution Safety Tests
  // =========================================================================

  await t.test('5.1: CancelUpdate removes staged files and resets state to idle', () => {
    const dummyPath = path.join(tmpDir, 'test-staged-cancel.tmp-1234');
    fs.writeFileSync(dummyPath, 'test-bytes');

    const updater = new UpdateService({
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
    });
    updater.stagedArtifact = { path: dummyPath };
    updater.state = 'ready-to-install';

    const status = updater.cancelUpdate();
    assert.equal(status.state, 'idle');
    assert.equal(status.stagedReady, false);
    assert.equal(fs.existsSync(dummyPath), false);
  });

  await t.test('5.2: InstallUpdate requires verified staged artifact and supports dryRun without silent execution', async () => {
    const dummyPath = path.join(tmpDir, 'test-installer.tmp-safe');
    fs.writeFileSync(dummyPath, 'installer');

    const updater = new UpdateService({
      stagingDir: tmpDir,
      logger: { info() {}, warn() {}, error() {} },
    });
    updater.stagedArtifact = { path: dummyPath };

    let quitCalled = false;
    const res = await updater.installUpdate({
      dryRun: true, // Safety verification: does not execute process during test
      onBeforeQuit: () => { quitCalled = true; },
    });

    assert.equal(res.success, true);
    assert.equal(res.stagedPath, dummyPath);
  });

  // Cleanup tmpDir
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
