'use strict';

/**
 * ManifestValidator
 * Strict schema and boundary validation for BARQ Downloader release manifests.
 * Prevents attribute injection, path traversal, downgrade attacks, and malformed metadata.
 */

const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);
const VALID_CHANNELS = new Set(['beta', 'stable']);
const EXPECTED_PRODUCT = 'BARQ Downloader';
const EXPECTED_PACKAGE_ID = 'com.barq.downloader';
const MAX_ARTIFACT_SIZE = 500 * 1024 * 1024; // 500 MB hard limit

const SEMVER_REGEX = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const SHA256_REGEX = /^[a-fA-F0-9]{64}$/;
const ARTIFACT_FILENAME_REGEX = /^BARQ-Downloader-(Setup|Portable)-[0-9a-zA-Z._-]+\.exe$/;

class ManifestValidator {
  /**
   * Parses a semantic version string.
   * @param {string} v
   * @returns {{ major: number, minor: number, patch: number, prerelease: string|null }|null}
   */
  static parseSemver(v) {
    const m = String(v).match(SEMVER_REGEX);
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      prerelease: m[4] || null,
    };
  }

  /**
   * Compares two semantic version strings.
   * @param {string} v1
   * @param {string} v2
   * @returns {number} 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
   */
  static compareSemver(v1, v2) {
    if (v1 === v2) return 0;
    const m1 = String(v1).match(SEMVER_REGEX);
    const m2 = String(v2).match(SEMVER_REGEX);
    if (!m1 || !m2) throw new Error(`Invalid semver comparison: "${v1}" vs "${v2}"`);

    const core1 = [Number(m1[1]), Number(m1[2]), Number(m1[3])];
    const core2 = [Number(m2[1]), Number(m2[2]), Number(m2[3])];

    for (let i = 0; i < 3; i++) {
      if (core1[i] > core2[i]) return 1;
      if (core1[i] < core2[i]) return -1;
    }

    // Pre-release comparison: normal version > pre-release version
    const pre1 = m1[4];
    const pre2 = m2[4];

    if (!pre1 && pre2) return 1;
    if (pre1 && !pre2) return -1;
    if (pre1 && pre2) {
      if (pre1 > pre2) return 1;
      if (pre1 < pre2) return -1;
    }

    return 0;
  }

  /**
   * Validates artifact sub-entry (installer or portable).
   * @param {object} artifact
   * @param {string} type 'installer' | 'portable'
   */
  static validateArtifact(artifact, type) {
    if (!artifact || typeof artifact !== 'object') {
      throw new Error(`Missing or invalid ${type} artifact object in manifest.`);
    }

    // 1. Filename validation — no directory traversal, strict pattern
    if (typeof artifact.filename !== 'string' || !artifact.filename.trim()) {
      throw new Error(`Artifact ${type} is missing filename.`);
    }
    const fn = artifact.filename.trim();
    if (fn.includes('/') || fn.includes('\\') || fn.includes('..') || fn.includes('\0')) {
      throw new Error(`Illegal path traversal or separator detected in ${type} filename: "${fn}".`);
    }
    if (!ARTIFACT_FILENAME_REGEX.test(fn)) {
      throw new Error(`Artifact ${type} filename does not conform to naming standard: "${fn}".`);
    }

    // 2. SHA-256 validation
    if (typeof artifact.sha256 !== 'string' || !SHA256_REGEX.test(artifact.sha256)) {
      throw new Error(`Artifact ${type} has invalid or missing SHA-256 checksum.`);
    }

    // 3. File size validation
    if (typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`Artifact ${type} size must be a positive integer.`);
    }
    if (artifact.size > MAX_ARTIFACT_SIZE) {
      throw new Error(`Artifact ${type} size (${artifact.size} bytes) exceeds maximum allowable limit (${MAX_ARTIFACT_SIZE} bytes).`);
    }

    // 4. Signature requirement flag
    if (artifact.signatureRequired !== undefined && typeof artifact.signatureRequired !== 'boolean') {
      throw new Error(`Artifact ${type} signatureRequired must be a boolean if specified.`);
    }
  }

  /**
   * Validates complete release manifest against schema and environment.
   * @param {object} manifest Parsed release manifest
   * @param {object} [opts] Validation context
   * @param {string} [opts.currentVersion] Currently running application version
   * @param {string} [opts.currentChannel] Currently configured release channel
   * @returns {{ valid: true, isNewer: boolean, isDowngrade: boolean, versionComparison: number }}
   */
  static validate(manifest, opts = {}) {
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('Manifest payload must be a non-null object.');
    }

    // 1. Schema Version
    if (!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
      throw new Error(`Unsupported manifest schema version "${manifest.schemaVersion}". Supported: [${[...SUPPORTED_SCHEMA_VERSIONS].join(', ')}].`);
    }

    // 2. Product Name & Package ID
    if (manifest.product !== EXPECTED_PRODUCT) {
      throw new Error(`Manifest product mismatch: expected "${EXPECTED_PRODUCT}", got "${manifest.product}".`);
    }
    if (manifest.packageId !== EXPECTED_PACKAGE_ID) {
      throw new Error(`Manifest packageId mismatch: expected "${EXPECTED_PACKAGE_ID}", got "${manifest.packageId}".`);
    }

    // 3. Semantic Version
    if (typeof manifest.version !== 'string' || !SEMVER_REGEX.test(manifest.version)) {
      throw new Error(`Manifest contains invalid version string: "${manifest.version}".`);
    }

    // 4. Release Channel
    if (typeof manifest.channel !== 'string' || !VALID_CHANNELS.has(manifest.channel)) {
      throw new Error(`Manifest contains invalid release channel: "${manifest.channel}".`);
    }
    if (opts.currentChannel && opts.currentChannel !== manifest.channel) {
      throw new Error(`Channel mismatch: manifest is for channel "${manifest.channel}", but application is set to "${opts.currentChannel}".`);
    }

    // 5. Publication Date
    if (typeof manifest.publishedAt !== 'string' || Number.isNaN(Date.parse(manifest.publishedAt))) {
      throw new Error(`Manifest contains invalid publishedAt timestamp: "${manifest.publishedAt}".`);
    }

    // 6. Minimum Supported Version Check
    if (manifest.minimumSupportedVersion !== undefined) {
      if (typeof manifest.minimumSupportedVersion !== 'string' || !SEMVER_REGEX.test(manifest.minimumSupportedVersion)) {
        throw new Error(`Manifest minimumSupportedVersion is invalid: "${manifest.minimumSupportedVersion}".`);
      }
      if (opts.currentVersion) {
        if (this.compareSemver(opts.currentVersion, manifest.minimumSupportedVersion) < 0) {
          throw new Error(
            `Installed version (${opts.currentVersion}) is below minimum supported version (${manifest.minimumSupportedVersion}). Manual re-installation required.`
          );
        }
      }
    }

    // 7. Platforms validation
    if (!manifest.platforms || typeof manifest.platforms !== 'object') {
      throw new Error('Manifest is missing required "platforms" object.');
    }
    const winX64 = manifest.platforms['win32-x64'];
    if (!winX64 || typeof winX64 !== 'object') {
      throw new Error('Manifest is missing required "win32-x64" platform entry.');
    }

    // Validate installer and/or portable artifacts
    if (!winX64.installer && !winX64.portable) {
      throw new Error('Platform "win32-x64" must provide at least one artifact ("installer" or "portable").');
    }
    if (winX64.installer) {
      this.validateArtifact(winX64.installer, 'installer');
    }
    if (winX64.portable) {
      this.validateArtifact(winX64.portable, 'portable');
    }

    // 8. Version Comparison vs Installed Version
    let isNewer = false;
    let isDowngrade = false;
    let comparison = 0;

    if (opts.currentVersion) {
      comparison = this.compareSemver(manifest.version, opts.currentVersion);
      if (comparison > 0) {
        isNewer = true;
      } else if (comparison < 0) {
        isDowngrade = true;
      }
    }

    return {
      valid: true,
      isNewer,
      isDowngrade,
      versionComparison: comparison,
    };
  }
}

module.exports = {
  ManifestValidator,
  SUPPORTED_SCHEMA_VERSIONS,
  VALID_CHANNELS,
  EXPECTED_PRODUCT,
  EXPECTED_PACKAGE_ID,
  SEMVER_REGEX,
  SHA256_REGEX,
  ARTIFACT_FILENAME_REGEX,
};
