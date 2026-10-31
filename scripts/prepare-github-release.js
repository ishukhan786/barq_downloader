'use strict';

/**
 * BARQ Downloader — GitHub Release Preparation & Packaging Tool
 * Prepares compliant release assets (installer, portable, manifest, signature, checksums)
 * for distribution via GitHub Releases (https://github.com/ishukhan786/barq_downloader).
 *
 * Usage:
 *   node scripts/prepare-github-release.js [--channel beta|stable] [--key /path/to/key.pem]
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const pkg = require('../package.json');
const brand = require('../src/shared/brand');
const { ManifestValidator } = require('../src/main/updater/ManifestValidator');
const { ManifestSigner } = require('../src/main/updater/ManifestSigner');
const { SignatureVerifier } = require('../src/main/updater/SignatureVerifier');

function getArg(flag, defaultValue = null) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : defaultValue;
}

function computeSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function run() {
  const channel = getArg('--channel', 'beta');
  const version = pkg.version;
  const tag = `v${version}`;
  const keyPath = getArg('--key', process.env.BARQ_UPDATE_PRIVATE_KEY_PATH || null);

  console.log('====================================================');
  console.log(`BARQ Downloader — GitHub Release Preparation (${tag})`);
  console.log(`Channel: ${channel} | Target: Windows x64`);
  console.log('====================================================\n');

  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const outputDir = path.join(rootDir, 'release', tag);

  fs.mkdirSync(outputDir, { recursive: true });

  const setupName = `BARQ-Downloader-Setup-${version}.exe`;
  const portableName = `BARQ-Downloader-Portable-${version}.exe`;

  const setupDistPath = path.join(distDir, setupName);
  const portableDistPath = path.join(distDir, portableName);

  if (!fs.existsSync(setupDistPath) || !fs.existsSync(portableDistPath)) {
    console.error('Error: Required binary artifacts not found in dist/.');
    console.error(`Expected:`);
    console.error(`  - ${setupDistPath}`);
    console.error(`  - ${portableDistPath}`);
    console.error('\nPlease run "npm run dist" first to build production installers.');
    process.exit(1);
  }

  // 1. Calculate actual artifact hashes and byte sizes
  console.log('1. Calculating cryptographic checksums from actual built binaries:');
  const setupSize = fs.statSync(setupDistPath).size;
  const setupHash = computeSha256(setupDistPath);
  console.log(`   Installer: ${setupName}`);
  console.log(`     Size: ${setupSize} bytes (${(setupSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`     SHA-256: ${setupHash}`);

  const portableSize = fs.statSync(portableDistPath).size;
  const portableHash = computeSha256(portableDistPath);
  console.log(`   Portable:  ${portableName}`);
  console.log(`     Size: ${portableSize} bytes (${(portableSize / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`     SHA-256: ${portableHash}\n`);

  // Copy binaries to release bundle directory
  const setupOutPath = path.join(outputDir, setupName);
  const portableOutPath = path.join(outputDir, portableName);
  fs.copyFileSync(setupDistPath, setupOutPath);
  fs.copyFileSync(portableDistPath, portableOutPath);

  // 2. Build canonical release manifest
  console.log('2. Assembling release manifest:');
  const manifest = {
    schemaVersion: 1,
    product: brand.PRODUCT_NAME || 'BARQ Downloader',
    packageId: 'com.barq.downloader',
    appId: 'com.barq.downloader',
    version,
    channel,
    publishedAt: new Date().toISOString(),
    minimumSupportedVersion: '0.1.0',
    platforms: {
      'win32-x64': {
        installer: {
          filename: setupName,
          sha256: setupHash,
          size: setupSize,
          signatureRequired: false,
        },
        portable: {
          filename: portableName,
          sha256: portableHash,
          size: portableSize,
          signatureRequired: false,
        },
      },
    },
    artifacts: [
      {
        type: 'installer',
        platform: 'win32',
        arch: 'x64',
        filename: setupName,
        sha256: setupHash,
        size: setupSize,
      },
      {
        type: 'portable',
        platform: 'win32',
        arch: 'x64',
        filename: portableName,
        sha256: portableHash,
        size: portableSize,
      },
    ],
    releaseNotes: `https://github.com/ishukhan786/barq_downloader/releases/tag/${tag}`,
  };

  // Validate manifest structure against schema
  ManifestValidator.validate(manifest, { currentVersion: version, currentChannel: channel });
  const manifestJson = JSON.stringify(manifest, null, 2);
  const manifestPath = path.join(outputDir, 'release-manifest.json');
  fs.writeFileSync(manifestPath, manifestJson, 'utf8');
  console.log(`   Saved manifest: ${manifestPath}`);

  // 3. Write SHA256SUMS.txt
  console.log('\n3. Generating SHA256SUMS.txt:');
  const manifestHash = computeSha256(manifestPath);
  const sumsContent = [
    `${setupHash}  ${setupName}`,
    `${portableHash}  ${portableName}`,
    `${manifestHash}  release-manifest.json`,
  ].join('\n') + '\n';

  const sumsPath = path.join(outputDir, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, sumsContent, 'utf8');
  console.log(`   Saved checksums file: ${sumsPath}`);

  // 4. Offline Ed25519 Signing
  console.log('\n4. Cryptographic Ed25519 Digital Signing:');
  const defaultDevKey = path.join(rootDir, 'dev-data', 'signing', 'barq-beta-2026-k1.private.pem');
  let privateKeyPem = process.env.BARQ_UPDATE_PRIVATE_KEY || null;
  if (!privateKeyPem) {
    const candidatePath = keyPath || (fs.existsSync(defaultDevKey) ? defaultDevKey : null);
    if (candidatePath && fs.existsSync(candidatePath)) {
      privateKeyPem = fs.readFileSync(candidatePath, 'utf8');
    }
  }

  const sigPath = path.join(outputDir, 'release-manifest.json.sig');
  if (privateKeyPem) {
    const keyId = 'barq-beta-2026-k1';
    const signed = ManifestSigner.sign(manifest, privateKeyPem, keyId);
    fs.writeFileSync(sigPath, signed.signature, 'utf8');
    console.log(`   Manifest signed with key "${keyId}".`);

    // Verify signature immediately
    const verifier = new SignatureVerifier();
    const check = verifier.verify(manifestJson, signed.signature, keyId);
    if (!check.verified) {
      console.error(`   ERROR: Local signature verification failed: ${check.error}`);
      process.exit(1);
    }
    console.log('   Local signature verification: VALID and authentic.');
  } else {
    // Generate an unsigned placeholder or test signature notice
    console.log('   Notice: No private key provided. Set BARQ_UPDATE_PRIVATE_KEY or pass --key <path> to sign.');
    console.log('   (Release manifest must be signed before publishing to public GitHub Releases).');
  }

  console.log('\n====================================================');
  console.log(`Release Bundle Ready in: ${outputDir}`);
  console.log('====================================================');
  console.log('Files created:');
  for (const f of fs.readdirSync(outputDir)) {
    const stat = fs.statSync(path.join(outputDir, f));
    console.log(`  - ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
  }

  console.log('\nNext Steps to Publish to GitHub Releases:');
  console.log('1. Go to: https://github.com/ishukhan786/barq_downloader/releases/new');
  console.log(`2. Select tag: ${tag}`);
  console.log(`3. Title: BARQ Downloader ${tag} (Public Beta)`);
  console.log(`4. Check: "Set as a pre-release" (${channel === 'beta'})`);
  console.log('5. Attach all files from the release folder:');
  console.log(`   - ${setupName}`);
  console.log(`   - ${portableName}`);
  console.log(`   - release-manifest.json`);
  console.log(`   - release-manifest.json.sig`);
  console.log(`   - SHA256SUMS.txt`);
  console.log('6. Click "Publish release".\n');
}

run();
