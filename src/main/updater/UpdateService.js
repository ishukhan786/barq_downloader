'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const brand = require('../../shared/brand');
const { ManifestValidator } = require('./ManifestValidator');
const { SignatureVerifier } = require('./SignatureVerifier');
const { CodeSigning } = require('./CodeSigning');

const DEFAULT_UPDATE_BASE_URL = 'https://updates.barq-downloader.org';
const MAX_MANIFEST_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_ARTIFACT_SIZE = 500 * 1024 * 1024; // 500 MB
const CONNECT_TIMEOUT_MS = 15000;

class UpdateService {
  /**
   * @param {object} opts
   * @param {string} [opts.channel] 'beta' | 'stable'
   * @param {string} [opts.currentVersion]
   * @param {string} [opts.stagingDir]
   * @param {SignatureVerifier} [opts.verifier]
   * @param {Function} [opts.broadcast]
   * @param {object} [opts.logger]
   */
  constructor({
    channel = 'beta',
    currentVersion = brand.VERSION || '0.1.0',
    stagingDir = null,
    verifier = null,
    broadcast = () => {},
    logger = console,
  } = {}) {
    this.channel = channel;
    this.currentVersion = currentVersion;
    this.stagingDir = stagingDir;
    this.verifier = verifier || new SignatureVerifier();
    this.broadcast = broadcast;
    this.logger = logger;

    this.state = 'idle';
    this.availableRelease = null;
    this.stagedArtifact = null;
    this.downloadProgress = { downloadedBytes: 0, totalBytes: 0, percent: 0 };
    this.lastError = null;
    this.activeRequest = null;
  }

  getStatus() {
    return {
      state: this.state,
      channel: this.channel,
      currentVersion: this.currentVersion,
      availableVersion: this.availableRelease ? this.availableRelease.version : null,
      publishedAt: this.availableRelease ? this.availableRelease.publishedAt : null,
      releaseNotes: this.availableRelease ? this.availableRelease.releaseNotes : null,
      artifactSize: this.availableRelease && this.availableRelease.artifact ? this.availableRelease.artifact.size : null,
      downloadProgress: this.downloadProgress,
      stagedReady: Boolean(this.stagedArtifact && fs.existsSync(this.stagedArtifact.path)),
      error: this.lastError,
    };
  }

  _setState(state, err = null) {
    this.state = state;
    this.lastError = err;
    this.logger.info(`UpdateService state changed to: ${state}`, { error: err });
    this.broadcast('updater:status-changed', this.getStatus());
  }

  /**
   * Sets release channel ('beta' or 'stable') with validation.
   * @param {string} channel
   */
  setChannel(channel) {
    if (channel !== 'beta' && channel !== 'stable') {
      throw new Error(`Invalid channel "${channel}". Must be 'beta' or 'stable'.`);
    }
    this.channel = channel;
    this.availableRelease = null;
    this._setState('idle');
  }

  /**
   * Securely performs an HTTPS GET request enforcing timeouts and size bounds.
   * Rejects non-HTTPS protocols and redirects to untrusted protocols.
   * @param {string} targetUrl
   * @param {number} maxBytes
   * @returns {Promise<Buffer>}
   */
  async _fetchHttps(targetUrl, maxBytes) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        return reject(new Error(`Invalid URL "${targetUrl}": ${err.message}`));
      }

      if (parsedUrl.protocol !== 'https:') {
        return reject(new Error(`Insecure protocol "${parsedUrl.protocol}" rejected. Update client requires HTTPS.`));
      }

      const req = https.get(parsedUrl, { timeout: CONNECT_TIMEOUT_MS }, (res) => {
        // Handle HTTP redirects securely
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, targetUrl).toString();
          if (!redirectUrl.startsWith('https://')) {
            return reject(new Error(`Insecure redirect to "${redirectUrl}" rejected.`));
          }
          return this._fetchHttps(redirectUrl, maxBytes).then(resolve, reject);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`Update server returned HTTP status ${res.statusCode} (${res.statusMessage})`));
        }

        const chunks = [];
        let bytesReceived = 0;

        res.on('data', (chunk) => {
          bytesReceived += chunk.length;
          if (bytesReceived > maxBytes) {
            req.destroy();
            return reject(new Error(`Payload exceeded maximum allowable size of ${maxBytes} bytes.`));
          }
          chunks.push(chunk);
        });

        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => reject(new Error(`Transfer error: ${err.message}`)));
      });

      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms.`));
      });

      req.on('error', (err) => reject(new Error(`Network request failed: ${err.message}`)));
      this.activeRequest = req;
    });
  }

  /**
   * Manually checks for updates on the configured channel.
   * @param {object} [opts]
   * @param {string} [opts.customManifestUrl] Override endpoint (for tests/custom servers)
   * @param {string|Buffer} [opts.mockSignature] Direct signature bypass (tests only)
   * @returns {Promise<object>} Status object
   */
  async checkForUpdates(opts = {}) {
    this._setState('checking');
    this.availableRelease = null;
    this.stagedArtifact = null;

    try {
      const manifestUrl = opts.customManifestUrl || process.env.BARQ_UPDATE_ENDPOINT || `${DEFAULT_UPDATE_BASE_URL}/${this.channel}/release-manifest.json`;
      const sigUrl = `${manifestUrl}.sig`;

      this.logger.info(`Checking for updates from: ${manifestUrl}`);

      // 1. Fetch manifest bytes
      const manifestBuf = await this._fetchHttps(manifestUrl, MAX_MANIFEST_SIZE);
      const rawManifestStr = manifestBuf.toString('utf8');

      // 2. Fetch detached Ed25519 signature
      let signatureStr;
      if (opts.mockSignature) {
        signatureStr = String(opts.mockSignature);
      } else {
        const sigBuf = await this._fetchHttps(sigUrl, 4096);
        signatureStr = sigBuf.toString('utf8').trim();
      }

      this._setState('verifying-manifest');

      // 3. Cryptographic Signature Verification
      const sigCheck = this.verifier.verify(rawManifestStr, signatureStr);
      if (!sigCheck.verified) {
        throw new Error(`Release manifest authenticity verification failed: ${sigCheck.error}`);
      }

      // 4. Strict Schema & Semantic Version Validation
      const manifestData = JSON.parse(rawManifestStr);
      const validation = ManifestValidator.validate(manifestData, {
        currentVersion: this.currentVersion,
        currentChannel: this.channel,
      });

      if (!validation.isNewer) {
        this.logger.info(`Installed version ${this.currentVersion} is up to date.`);
        this._setState('no-update');
        return this.getStatus();
      }

      const winX64 = manifestData.platforms['win32-x64'];
      const targetArtifact = winX64.installer || winX64.portable;

      this.availableRelease = {
        version: manifestData.version,
        publishedAt: manifestData.publishedAt,
        releaseNotes: manifestData.releaseNotes || 'Bug fixes and performance improvements.',
        artifact: targetArtifact,
        artifactType: winX64.installer ? 'installer' : 'portable',
        manifestUrl,
      };

      this._setState('update-available');
      return this.getStatus();
    } catch (err) {
      this.logger.error('Update check failed:', err);
      this._setState('failed', err.message);
      return this.getStatus();
    } finally {
      this.activeRequest = null;
    }
  }

  /**
   * Downloads verified update artifact into an isolated temporary staging file.
   * @param {object} [opts]
   * @param {string} [opts.artifactBaseUrl]
   * @returns {Promise<object>} Status object
   */
  async downloadUpdate(opts = {}) {
    if (!this.availableRelease || !this.availableRelease.artifact) {
      throw new Error('No verified update is currently available to download.');
    }

    this._setState('downloading');
    this.downloadProgress = { downloadedBytes: 0, totalBytes: this.availableRelease.artifact.size, percent: 0 };

    const artifactMeta = this.availableRelease.artifact;
    const resolvedStagingDir = this.stagingDir || path.join(require('node:os').tmpdir(), 'barq-update-staging');
    fs.mkdirSync(resolvedStagingDir, { recursive: true });

    const randomSuffix = crypto.randomBytes(16).toString('hex');
    const tempFilePath = path.join(resolvedStagingDir, `barq-update-${artifactMeta.filename}.tmp-${randomSuffix}`);

    try {
      const artifactUrl = opts.artifactBaseUrl
        ? `${opts.artifactBaseUrl}/${artifactMeta.filename}`
        : new URL(artifactMeta.filename, this.availableRelease.manifestUrl).toString();

      this.logger.info(`Downloading update artifact from ${artifactUrl} to ${tempFilePath}`);

      // Stream download to temporary staging file
      await new Promise((resolve, reject) => {
        let parsedUrl;
        try { parsedUrl = new URL(artifactUrl); } catch (e) { return reject(e); }

        if (parsedUrl.protocol !== 'https:') {
          return reject(new Error('Update artifact download must use HTTPS.'));
        }

        const outStream = fs.createWriteStream(tempFilePath, { mode: 0o700 });
        const hashStream = crypto.createHash('sha256');
        let downloaded = 0;

        const req = https.get(parsedUrl, { timeout: CONNECT_TIMEOUT_MS }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            outStream.close();
            try { fs.rmSync(tempFilePath, { force: true }); } catch {}
            return reject(new Error('Redirect during artifact binary download is not supported.'));
          }

          if (res.statusCode !== 200) {
            outStream.close();
            try { fs.rmSync(tempFilePath, { force: true }); } catch {}
            return reject(new Error(`Failed to download artifact: HTTP ${res.statusCode}`));
          }

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (downloaded > MAX_ARTIFACT_SIZE) {
              req.destroy();
              outStream.close();
              return reject(new Error(`Artifact exceeded maximum size limit of ${MAX_ARTIFACT_SIZE} bytes.`));
            }
            hashStream.update(chunk);
            this.downloadProgress.downloadedBytes = downloaded;
            this.downloadProgress.percent = artifactMeta.size > 0 ? Math.min(100, Math.round((downloaded / artifactMeta.size) * 100)) : 0;
            this.broadcast('updater:status-changed', this.getStatus());
          });

          res.pipe(outStream);

          outStream.on('finish', () => {
            const actualDigest = hashStream.digest('hex');
            resolve({ downloaded, actualDigest });
          });

          outStream.on('error', (err) => reject(err));
        });

        req.on('timeout', () => { req.destroy(); reject(new Error('Artifact download timed out.')); });
        req.on('error', (err) => reject(err));
        this.activeRequest = req;
      });

      this._setState('verifying-artifact');

      // 1. Verify byte size
      const stat = fs.statSync(tempFilePath);
      if (stat.size !== artifactMeta.size) {
        throw new Error(`Artifact size mismatch: expected ${artifactMeta.size} bytes, got ${stat.size} bytes.`);
      }

      // 2. Verify SHA-256 Digest
      const finalBuf = fs.readFileSync(tempFilePath);
      const computedHash = crypto.createHash('sha256').update(finalBuf).digest('hex');

      const expectedBuf = Buffer.from(artifactMeta.sha256.toLowerCase(), 'utf8');
      const actualBuf = Buffer.from(computedHash.toLowerCase(), 'utf8');

      if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
        throw new Error(`SHA-256 verification failed: digest does not match release manifest.`);
      }

      // 3. Optional Authenticode Signature check
      if (artifactMeta.signatureRequired && process.platform === 'win32') {
        const authCheck = CodeSigning.verifyFileSignature(tempFilePath);
        if (!authCheck.signed) {
          throw new Error(`Authenticode publisher verification failed: ${authCheck.error}`);
        }
      }

      this.stagedArtifact = {
        path: tempFilePath,
        filename: artifactMeta.filename,
        sha256: computedHash,
        size: stat.size,
      };

      this._setState('ready-to-install');
      return this.getStatus();
    } catch (err) {
      this.logger.error('Artifact download/verification failed:', err);
      if (fs.existsSync(tempFilePath)) {
        try { fs.rmSync(tempFilePath, { force: true }); } catch {}
      }
      this._setState('failed', err.message);
      return this.getStatus();
    } finally {
      this.activeRequest = null;
    }
  }

  /**
   * Triggers update installation with explicit user consent.
   * Spawns installer and exits main process.
   */
  async installUpdate(opts = {}) {
    if (!this.stagedArtifact || !fs.existsSync(this.stagedArtifact.path)) {
      throw new Error('No verified update is staged and ready to install.');
    }

    this.logger.info(`Installing update from staged artifact: ${this.stagedArtifact.path}`);

    // Spawn installer executable detached
    if (!opts.dryRun) {
      const child = spawn(this.stagedArtifact.path, ['--updated'], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();

      // Signal application to quit cleanly
      if (typeof opts.onBeforeQuit === 'function') {
        opts.onBeforeQuit();
      }
    }

    return { success: true, stagedPath: this.stagedArtifact.path };
  }

  /**
   * Cancels active update operations and deletes staged files.
   */
  cancelUpdate() {
    if (this.activeRequest) {
      try { this.activeRequest.destroy(); } catch {}
      this.activeRequest = null;
    }

    if (this.stagedArtifact && fs.existsSync(this.stagedArtifact.path)) {
      try { fs.rmSync(this.stagedArtifact.path, { force: true }); } catch {}
    }

    this.availableRelease = null;
    this.stagedArtifact = null;
    this._setState('idle');
    return this.getStatus();
  }
}

module.exports = { UpdateService, DEFAULT_UPDATE_BASE_URL, MAX_MANIFEST_SIZE, MAX_ARTIFACT_SIZE };
