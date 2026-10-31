'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ManifestValidator,
  EXPECTED_PRODUCT,
  EXPECTED_PACKAGE_ID,
} = require('../src/main/updater/ManifestValidator');

test('BARQ Downloader — Milestone 8 Manifest Validation Suite', async (t) => {
  const validManifest = {
    schemaVersion: 1,
    product: EXPECTED_PRODUCT,
    packageId: EXPECTED_PACKAGE_ID,
    version: '0.2.0',
    channel: 'beta',
    publishedAt: '2026-11-01T12:00:00.000Z',
    minimumSupportedVersion: '0.1.0',
    notesUrl: 'https://example.invalid/releases/v0.2.0.html',
    platforms: {
      'win32-x64': {
        installer: {
          filename: 'BARQ-Downloader-Setup-0.2.0.exe',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          size: 55000000,
          signatureRequired: false,
        },
        portable: {
          filename: 'BARQ-Downloader-Portable-0.2.0.exe',
          sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          size: 58000000,
          signatureRequired: false,
        },
      },
    },
  };

  await t.test('1.1: Accepts compliant release manifest schema version 1', () => {
    const res = ManifestValidator.validate(validManifest, { currentVersion: '0.1.0' });
    assert.equal(res.valid, true);
    assert.equal(res.isNewer, true);
    assert.equal(res.isDowngrade, false);
  });

  await t.test('1.2: Rejects manifest with unsupported schemaVersion', () => {
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, schemaVersion: 2 }),
      /Unsupported manifest schema version/
    );
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, schemaVersion: 0 }),
      /Unsupported manifest schema version/
    );
  });

  await t.test('1.3: Rejects manifest with invalid product or packageId', () => {
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, product: 'FakeDownloader' }),
      /Manifest product mismatch/
    );
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, packageId: 'com.fake.app' }),
      /Manifest packageId mismatch/
    );
  });

  await t.test('1.4: Rejects manifest with missing or invalid SemVer version', () => {
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, version: 'invalid-semver' }),
      /invalid version string/
    );
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, version: '' }),
      /invalid version string/
    );
  });

  await t.test('1.5: Rejects manifest with invalid channel or channel mismatch', () => {
    assert.throws(
      () => ManifestValidator.validate({ ...validManifest, channel: 'nightly' }),
      /invalid release channel/
    );
    assert.throws(
      () => ManifestValidator.validate(validManifest, { currentChannel: 'stable' }),
      /Channel mismatch/
    );
  });

  await t.test('1.6: Rejects manifest with path traversal in artifact filenames', () => {
    const badTraversal = JSON.parse(JSON.stringify(validManifest));
    badTraversal.platforms['win32-x64'].installer.filename = '../../Windows/System32/evil.exe';
    assert.throws(
      () => ManifestValidator.validate(badTraversal),
      /Illegal path traversal/
    );

    const badUnc = JSON.parse(JSON.stringify(validManifest));
    badUnc.platforms['win32-x64'].installer.filename = '\\\\server\\share\\BARQ-Downloader-Setup-0.2.0.exe';
    assert.throws(
      () => ManifestValidator.validate(badUnc),
      /Illegal path traversal/
    );
  });

  await t.test('1.7: Rejects manifest with invalid SHA-256 or out-of-bounds sizes', () => {
    const badHash = JSON.parse(JSON.stringify(validManifest));
    badHash.platforms['win32-x64'].installer.sha256 = 'not-a-valid-sha256';
    assert.throws(
      () => ManifestValidator.validate(badHash),
      /SHA-256 checksum/
    );

    const badSize = JSON.parse(JSON.stringify(validManifest));
    badSize.platforms['win32-x64'].installer.size = 600 * 1024 * 1024; // > 500 MB limit
    assert.throws(
      () => ManifestValidator.validate(badSize),
      /exceeds maximum allowable limit/
    );
  });

  await t.test('2.1: SemVer parsing correctly parses standard and pre-release versions', () => {
    const p1 = ManifestValidator.parseSemver('0.1.0');
    assert.deepEqual(p1, { major: 0, minor: 1, patch: 0, prerelease: null });

    const p2 = ManifestValidator.parseSemver('1.2.3-beta.1');
    assert.deepEqual(p2, { major: 1, minor: 2, patch: 3, prerelease: 'beta.1' });

    assert.equal(ManifestValidator.parseSemver('bad'), null);
  });

  await t.test('2.2: SemVer comparison accurately detects updates, downgrades, and equality', () => {
    // 0.2.0 vs 0.1.0 -> 1 (newer)
    assert.equal(ManifestValidator.compareSemver('0.2.0', '0.1.0'), 1);
    // 0.1.0 vs 0.2.0 -> -1 (older / downgrade)
    assert.equal(ManifestValidator.compareSemver('0.1.0', '0.2.0'), -1);
    // 0.1.0 vs 0.1.0 -> 0 (equal)
    assert.equal(ManifestValidator.compareSemver('0.1.0', '0.1.0'), 0);
    // pre-release lower than final release
    assert.equal(ManifestValidator.compareSemver('1.0.0-beta.1', '1.0.0'), -1);
    assert.equal(ManifestValidator.compareSemver('1.0.0', '1.0.0-beta.1'), 1);
  });

  await t.test('2.3: Enforces minimum supported version upgrade gate', () => {
    // Current is 0.0.9, but manifest requires minimumSupportedVersion: 0.1.0
    assert.throws(
      () => ManifestValidator.validate(validManifest, { currentVersion: '0.0.9' }),
      /minimum supported version/
    );
  });
});
