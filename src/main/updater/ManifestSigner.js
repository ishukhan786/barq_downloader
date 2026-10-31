'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { canonicalize } = require('./SignatureVerifier');

class ManifestSigner {
  /**
   * Signs a manifest object or canonical string with an offline Ed25519 private key.
   * @param {object|string} manifest
   * @param {string|Buffer} privateKeyPem
   * @param {string} keyId
   * @returns {{ signature: string, keyId: string, canonicalBytes: number }}
   */
  static sign(manifest, privateKeyPem, keyId) {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('keyId is required for release signing.');
    }
    if (!privateKeyPem) {
      throw new Error('privateKeyPem is required for release signing.');
    }

    const canonicalStr = typeof manifest === 'string'
      ? (manifest.startsWith('{') ? canonicalize(JSON.parse(manifest)) : manifest)
      : canonicalize(manifest);

    const canonicalBytes = Buffer.from(canonicalStr, 'utf8');

    const privKey = typeof privateKeyPem === 'string' && fs.existsSync(privateKeyPem)
      ? fs.readFileSync(privateKeyPem, 'utf8')
      : privateKeyPem;

    const signatureBuf = crypto.sign(null, canonicalBytes, privKey);
    const signatureBase64 = signatureBuf.toString('base64');

    return {
      signature: signatureBase64,
      signatureBase64,
      algorithm: 'ed25519',
      keyId,
      canonicalBytes: canonicalBytes.length,
    };
  }
}

module.exports = { ManifestSigner };
