'use strict';

/**
 * Generates release-manifest.json and detached Ed25519 signature from built artifacts.
 * Usage: node scripts/generate-manifest.js [--channel beta|stable]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const brand = require('../src/shared/brand');
const pkg = require('../package.json');
const { ManifestValidator } = require('../src/main/updater/ManifestValidator');
const { ManifestSigner } = require('../src/main/updater/ManifestSigner');

function fileHash(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function run() {
  const channel = process.argv.includes('--channel')
    ? process.argv[process.argv.indexOf('--channel') + 1]
    : 'beta';

  const version = pkg.version;
  const distDir = path.join(__dirname, '..', 'dist');
  const releaseDir = path.join(__dirname, '..', 'release', `v${version}`);
  fs.mkdirSync(releaseDir, { recursive: true });

  const installerName = `BARQ-Downloader-Setup-${version}.exe`;
  const portableName = `BARQ-Downloader-Portable-${version}.exe`;

  const installerPath = path.join(distDir, installerName);
  const portablePath = path.join(distDir, portableName);

  const platforms = {
    'win32-x64': {},
  };

  if (fs.existsSync(installerPath)) {
    const size = fs.statSync(installerPath).size;
    const sha256 = fileHash(installerPath);
    platforms['win32-x64'].installer = {
      filename: installerName,
      sha256,
      size,
      signatureRequired: false,
    };
    fs.copyFileSync(installerPath, path.join(releaseDir, installerName));
    console.log(`Included installer: ${installerName} (${(size / (1024 * 1024)).toFixed(2)} MB, SHA256: ${sha256.slice(0, 16)}...)`);
  }

  if (fs.existsSync(portablePath)) {
    const size = fs.statSync(portablePath).size;
    const sha256 = fileHash(portablePath);
    platforms['win32-x64'].portable = {
      filename: portableName,
      sha256,
      size,
      signatureRequired: false,
    };
    fs.copyFileSync(portablePath, path.join(releaseDir, portableName));
    console.log(`Included portable: ${portableName} (${(size / (1024 * 1024)).toFixed(2)} MB, SHA256: ${sha256.slice(0, 16)}...)`);
  }

  if (!platforms['win32-x64'].installer && !platforms['win32-x64'].portable) {
    console.warn('Warning: No built artifacts found in dist/. Generating manifest with synthetic metadata.');
    platforms['win32-x64'].installer = {
      filename: installerName,
      sha256: crypto.createHash('sha256').update(installerName).digest('hex'),
      size: 65000000,
      signatureRequired: false,
    };
  }

  const manifest = {
    schemaVersion: 1,
    product: brand.PRODUCT_NAME || 'BARQ Downloader',
    packageId: 'com.barq.downloader',
    version,
    channel,
    publishedAt: new Date().toISOString(),
    minimumSupportedVersion: '0.1.0',
    platforms,
    releaseNotes: `https://github.com/barq-downloader/barq/releases/tag/v${version}`,
  };

  // Validate manifest schema
  ManifestValidator.validate(manifest, { currentVersion: version, currentChannel: channel });

  const manifestPath = path.join(releaseDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Saved release manifest to: ${manifestPath}`);

  // Also write SHA256SUMS.txt
  const checksumsPath = path.join(releaseDir, 'SHA256SUMS.txt');
  const sums = [];
  if (platforms['win32-x64'].installer) {
    sums.push(`${platforms['win32-x64'].installer.sha256}  ${platforms['win32-x64'].installer.filename}`);
  }
  if (platforms['win32-x64'].portable) {
    sums.push(`${platforms['win32-x64'].portable.sha256}  ${platforms['win32-x64'].portable.filename}`);
  }
  sums.push(`${fileHash(manifestPath)}  release-manifest.json`);
  fs.writeFileSync(checksumsPath, sums.join('\n') + '\n', 'utf8');
  console.log(`Saved checksums to: ${checksumsPath}`);

  // Sign manifest if private key is available
  const devKeyPath = path.join(__dirname, '..', 'dev-data', 'signing', 'barq-beta-2026-k1.private.pem');
  const privKey = process.env.BARQ_UPDATE_PRIVATE_KEY || (fs.existsSync(devKeyPath) ? fs.readFileSync(devKeyPath, 'utf8') : null);

  if (privKey) {
    const keyId = 'barq-beta-2026-k1';
    const signed = ManifestSigner.sign(manifest, privKey, keyId);
    const sigPath = path.join(releaseDir, 'release-manifest.json.sig');
    fs.writeFileSync(sigPath, signed.signature, 'utf8');
    console.log(`Signed release manifest with key "${keyId}". Signature saved to: ${sigPath}`);
  } else {
    console.log('Notice: No private key found. Release manifest left unsigned (dev mode).');
  }
}

run();
