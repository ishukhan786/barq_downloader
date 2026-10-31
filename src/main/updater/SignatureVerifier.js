'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_KEYS_PATH = path.join(__dirname, 'keys', 'trusted-keys.json');

/**
 * Deterministically canonicalizes a JavaScript value according to RFC 8785 principles.
 * Handles objects with sorted keys, arrays, strings, numbers, booleans, and null.
 * @param {*} val
 * @returns {string}
 */
function canonicalize(val) {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }

  if (Array.isArray(val)) {
    return '[' + val.map(canonicalize).join(',') + ']';
  }

  const keys = Object.keys(val).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(val[k])}`);
  return `{${entries.join(',')}}`;
}

class SignatureVerifier {
  /**
   * @param {object} [optsOrKeys] Keystore object or options { keysPath, keysOverride }
   */
  constructor(optsOrKeys = {}) {
    if (optsOrKeys && Array.isArray(optsOrKeys.keys)) {
      this.keysPath = DEFAULT_KEYS_PATH;
      this.keysData = optsOrKeys;
    } else {
      const { keysPath = DEFAULT_KEYS_PATH, keysOverride = null } = optsOrKeys || {};
      this.keysPath = keysPath;
      this.keysData = keysOverride || this._loadKeys(keysPath);
    }
  }

  _loadKeys(keysFile) {
    try {
      if (!fs.existsSync(keysFile)) {
        throw new Error(`Trusted keys file not found at: ${keysFile}`);
      }
      const raw = fs.readFileSync(keysFile, 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to load trusted public keys: ${err.message}`);
    }
  }

  /**
   * Finds a trusted public key by its ID and validates validity timestamps.
   * @param {string} keyId
   * @returns {object} key record
   */
  getKey(keyId) {
    if (!keyId || typeof keyId !== 'string') {
      throw new Error('Key ID must be a non-empty string.');
    }

    if (!this.keysData || !Array.isArray(this.keysData.keys)) {
      throw new Error('No trusted keys configured in keystore.');
    }

    const keyRecord = this.keysData.keys.find((k) => k.id === keyId);
    if (!keyRecord) {
      throw new Error(`Untrusted signing key ID: "${keyId}". Not present in trusted keystore.`);
    }

    // Verify key algorithm is Ed25519
    if (keyRecord.algorithm !== 'ed25519') {
      throw new Error(`Unsupported key algorithm: "${keyRecord.algorithm}". Only ed25519 is accepted.`);
    }

    // Verify validity window
    const now = Date.now();
    if (keyRecord.validFrom && Date.parse(keyRecord.validFrom) > now) {
      throw new Error(`Signing key "${keyId}" is not yet active (valid from ${keyRecord.validFrom}).`);
    }
    if (keyRecord.validUntil && Date.parse(keyRecord.validUntil) < now) {
      throw new Error(`Signing key "${keyId}" has expired (valid until ${keyRecord.validUntil}).`);
    }

    return keyRecord;
  }

  /**
   * Verifies an Ed25519 detached signature against an arbitrary manifest payload.
   * @param {object|string|Buffer} manifest Manifest object, canonical string, or raw buffer
   * @param {string|object} sigInput Base64-encoded 64-byte Ed25519 signature string or { signature, keyId }
   * @param {string} [keyId] Expected key identifier (defaults to keystore activeKeyId)
   * @returns {{ verified: boolean, keyId: string, canonicalLength: number, error?: string }}
   */
  verify(manifest, sigInput, keyId = null) {
    let signatureBase64 = sigInput;
    let activeId = keyId;

    if (sigInput && typeof sigInput === 'object' && !Buffer.isBuffer(sigInput)) {
      signatureBase64 = sigInput.signature || sigInput.signatureBase64;
      activeId = activeId || sigInput.keyId;
    }

    try {
      activeId = activeId || this.keysData.activeKeyId;
      const keyRecord = this.getKey(activeId);

      if (!signatureBase64 || typeof signatureBase64 !== 'string') {
        return { verified: false, keyId: activeId, error: 'Signature must be a non-empty base64 string.' };
      }

      const sigBuffer = Buffer.from(signatureBase64.trim(), 'base64');
      if (sigBuffer.length !== 64) {
        return { verified: false, keyId: activeId, error: `Invalid Ed25519 signature length: expected 64 bytes, got ${sigBuffer.length}.` };
      }

      // Compute deterministic canonical representation
      let canonicalStr;
      if (typeof manifest === 'string') {
        try {
          const parsed = JSON.parse(manifest);
          canonicalStr = canonicalize(parsed);
        } catch {
          canonicalStr = manifest;
        }
      } else if (Buffer.isBuffer(manifest)) {
        try {
          const parsed = JSON.parse(manifest.toString('utf8'));
          canonicalStr = canonicalize(parsed);
        } catch {
          canonicalStr = manifest.toString('utf8');
        }
      } else if (typeof manifest === 'object' && manifest !== null) {
        canonicalStr = canonicalize(manifest);
      } else {
        return { verified: false, keyId: activeId, error: 'Invalid manifest payload type.' };
      }

      const canonicalBytes = Buffer.from(canonicalStr, 'utf8');

      // Verify Ed25519 signature
      const pubKey = keyRecord.publicKey || keyRecord.publicKeySpkiPem;
      const verified = crypto.verify(null, canonicalBytes, pubKey, sigBuffer);

      return {
        verified,
        keyId: activeId,
        canonicalLength: canonicalBytes.length,
        error: verified ? null : 'Cryptographic signature mismatch: manifest bytes do not match signature.',
      };
    } catch (err) {
      return {
        verified: false,
        keyId: keyId || 'unknown',
        error: err.message,
      };
    }
  }
}

module.exports = {
  SignatureVerifier,
  canonicalize,
  DEFAULT_KEYS_PATH,
};
