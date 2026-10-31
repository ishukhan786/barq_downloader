'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { UpdateService } = require('../src/main/updater/UpdateService');
const { ManifestValidator, EXPECTED_PRODUCT, EXPECTED_PACKAGE_ID } = require('../src/main/updater/ManifestValidator');

test('BARQ Downloader — Milestone 8 UpdateService Client & Security Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barq-updater-test-'));

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1.1: Rejects insecure non-HTTPS update endpoints', async () => {
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
    });

    const res = await updater.checkForUpdates({
      customManifestUrl: 'http://insecure-update.invalid/manifest.json',
    });
    assert.equal(res.state, 'failed');
    assert.ok(res.error.includes('HTTPS'));
  });

  await t.test('1.2: Enforces channel validation on setChannel', () => {
    const updater = new UpdateService({ stagingDir: tmpDir });
    assert.equal(updater.channel, 'beta');

    updater.setChannel('stable');
    assert.equal(updater.channel, 'stable');

    assert.throws(
      () => updater.setChannel('nightly'),
      /Invalid channel/
    );
  });

  await t.test('1.3: Accurately identifies downgrade attacks and up-to-date versions', () => {
    // Current is 0.2.0, manifest is 0.1.0
    const olderManifest = {
      schemaVersion: 1,
      product: EXPECTED_PRODUCT,
      packageId: EXPECTED_PACKAGE_ID,
      version: '0.1.0',
      channel: 'beta',
      publishedAt: '2026-11-01T12:00:00.000Z',
      platforms: {
        'win32-x64': {
          installer: {
            filename: 'BARQ-Downloader-Setup-0.1.0.exe',
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            size: 55000000,
            signatureRequired: false,
          },
        },
      },
    };

    const res = ManifestValidator.validate(olderManifest, {
      currentVersion: '0.2.0',
      currentChannel: 'beta',
    });
    assert.equal(res.valid, true);
    assert.equal(res.isNewer, false);
    assert.equal(res.isDowngrade, true);
  });

  await t.test('1.4: Accurately validates upgrade availability', () => {
    // Current is 0.1.0, manifest is 0.2.0
    const newerManifest = {
      schemaVersion: 1,
      product: EXPECTED_PRODUCT,
      packageId: EXPECTED_PACKAGE_ID,
      version: '0.2.0',
      channel: 'beta',
      publishedAt: '2026-11-01T12:00:00.000Z',
      platforms: {
        'win32-x64': {
          installer: {
            filename: 'BARQ-Downloader-Setup-0.2.0.exe',
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
            size: 55000000,
            signatureRequired: false,
          },
        },
      },
    };

    const res = ManifestValidator.validate(newerManifest, {
      currentVersion: '0.1.0',
      currentChannel: 'beta',
    });
    assert.equal(res.valid, true);
    assert.equal(res.isNewer, true);
    assert.equal(res.isDowngrade, false);
  });

  await t.test('1.5: Broadcasts state change notifications cleanly', () => {
    const events = [];
    const updater = new UpdateService({
      stagingDir: tmpDir,
      currentVersion: '0.1.0',
      broadcast: (ch, payload) => events.push({ ch, payload }),
    });

    updater._setState('checking');
    assert.equal(events.length, 1);
    assert.equal(events[0].ch, 'updater:status-changed');
    assert.equal(events[0].payload.state, 'checking');
    assert.equal(events[0].payload.currentVersion, '0.1.0');
  });

  await t.test('1.6: Refuses to download when no update is available', async () => {
    const updater = new UpdateService({ stagingDir: tmpDir });
    await assert.rejects(
      () => updater.downloadUpdate(),
      /No verified update is currently available/
    );
  });
});
