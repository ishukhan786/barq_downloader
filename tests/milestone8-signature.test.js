'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { canonicalize, SignatureVerifier } = require('../src/main/updater/SignatureVerifier');
const { ManifestSigner } = require('../src/main/updater/ManifestSigner');

test('BARQ Downloader — Milestone 8 Cryptographic Signature Verification Suite', async (t) => {
  // Generate a test ephemeral Ed25519 keypair
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const testKeyStore = {
    keys: [
      {
        id: 'test-ed25519-key-1',
        algorithm: 'ed25519',
        role: 'beta-release-signing',
        status: 'active',
        publicKeySpkiPem: pubPem,
        validFrom: '2026-01-01T00:00:00Z',
        validUntil: '2028-01-01T00:00:00Z',
      },
      {
        id: 'test-expired-key',
        algorithm: 'ed25519',
        role: 'beta-release-signing',
        status: 'active',
        publicKeySpkiPem: pubPem,
        validFrom: '2020-01-01T00:00:00Z',
        validUntil: '2021-01-01T00:00:00Z', // Expired
      },
    ],
  };

  const sampleManifest = {
    schemaVersion: 1,
    product: 'BARQ Downloader',
    version: '0.1.0',
    channel: 'beta',
    notes: 'Sample test manifest',
    publishedAt: '2026-11-01T00:00:00Z',
  };

  await t.test('1.1: Canonicalization produces identical byte streams regardless of JSON key ordering', () => {
    const objA = { z: 1, a: 2, m: { y: 'b', x: 'a' } };
    const objB = { a: 2, m: { x: 'a', y: 'b' }, z: 1 };

    const canonA = canonicalize(objA);
    const canonB = canonicalize(objB);

    assert.equal(canonA, canonB);
    assert.equal(canonA, '{"a":2,"m":{"x":"a","y":"b"},"z":1}');
  });

  await t.test('1.2: Correctly signs and verifies valid manifest with Ed25519 detached signature', () => {
    const signature = ManifestSigner.sign(sampleManifest, privPem, 'test-ed25519-key-1');
    assert.equal(signature.algorithm, 'ed25519');
    assert.equal(signature.keyId, 'test-ed25519-key-1');
    assert.ok(signature.signatureBase64.length > 30);

    const verifier = new SignatureVerifier(testKeyStore);
    const res = verifier.verify(sampleManifest, signature);
    assert.equal(res.verified, true);
    assert.equal(res.keyId, 'test-ed25519-key-1');
  });

  await t.test('1.3: Rejects manifest when payload is tampered (even by single character)', () => {
    const signature = ManifestSigner.sign(sampleManifest, privPem, 'test-ed25519-key-1');
    const tampered = { ...sampleManifest, version: '0.1.1-tampered' };

    const verifier = new SignatureVerifier(testKeyStore);
    const res = verifier.verify(tampered, signature);
    assert.equal(res.verified, false);
    assert.ok(res.error.includes('mismatch'));
  });

  await t.test('1.4: Rejects signature when signature bytes are corrupted', () => {
    const signature = ManifestSigner.sign(sampleManifest, privPem, 'test-ed25519-key-1');
    const corruptedBase64 = 'A' + signature.signature.slice(1);
    const corruptedSig = {
      ...signature,
      signature: corruptedBase64,
      signatureBase64: corruptedBase64,
    };

    const verifier = new SignatureVerifier(testKeyStore);
    const res = verifier.verify(sampleManifest, corruptedSig);
    assert.equal(res.verified, false);
  });

  await t.test('1.5: Rejects signature referencing unknown or untrusted keyId', () => {
    const signature = ManifestSigner.sign(sampleManifest, privPem, 'untrusted-rogue-key');

    const verifier = new SignatureVerifier(testKeyStore);
    const res = verifier.verify(sampleManifest, signature);
    assert.equal(res.verified, false);
    assert.ok(res.error.includes('Untrusted signing key'));
  });

  await t.test('1.6: Rejects signature referencing expired signing key', () => {
    const signature = ManifestSigner.sign(sampleManifest, privPem, 'test-expired-key');

    const verifier = new SignatureVerifier(testKeyStore);
    const res = verifier.verify(sampleManifest, signature);
    assert.equal(res.verified, false);
    assert.ok(res.error.includes('expired'));
  });

  await t.test('1.7: Verified trusted-keys.json active release key verifies generated release signature', () => {
    const fs = require('node:fs');
    const path = require('node:path');

    const releaseManifestPath = path.join(__dirname, '..', 'release', 'v0.1.0', 'release-manifest.json');
    const releaseSigPath = path.join(__dirname, '..', 'release', 'v0.1.0', 'release-manifest.json.sig');

    if (fs.existsSync(releaseManifestPath) && fs.existsSync(releaseSigPath)) {
      const manifest = JSON.parse(fs.readFileSync(releaseManifestPath, 'utf8'));
      const sig = fs.readFileSync(releaseSigPath, 'utf8').trim();

      const verifier = new SignatureVerifier(); // Uses default production keystore
      const res = verifier.verify(manifest, sig);
      assert.equal(res.verified, true, `Production v0.1.0 manifest signature must verify: ${res.error}`);
    }
  });
});
