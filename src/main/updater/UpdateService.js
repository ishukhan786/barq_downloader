'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const brand = require('../../shared/brand');
const { ManifestValidator, SEMVER_REGEX } = require('./ManifestValidator');
const { SignatureVerifier } = require('./SignatureVerifier');
const { CodeSigning } = require('./CodeSigning');

const DEFAULT_GITHUB_OWNER = 'ishukhan786';
const DEFAULT_GITHUB_REPO = 'barq_downloader';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const DEFAULT_UPDATE_BASE_URL = 'https://updates.barq-downloader.org';

const MAX_MANIFEST_SIZE = 1 * 1024 * 1024; // 1 MB
const MAX_ARTIFACT_SIZE = 500 * 1024 * 1024; // 500 MB
const CONNECT_TIMEOUT_MS = 15000;
const MAX_REDIRECT_HOPS = 5;

// Approved hosts for GitHub Releases API, releases assets, and CDN storage
const APPROVED_REDIRECT_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'raw.githubusercontent.com',
]);

class UpdateService {
  /**
   * @param {object} opts
   * @param {string} [opts.channel] 'beta' | 'stable'
   * @param {string} [opts.currentVersion]
   * @param {string} [opts.stagingDir]
   * @param {SignatureVerifier} [opts.verifier]
   * @param {Function} [opts.broadcast]
   * @param {object} [opts.logger]
   * @param {string} [opts.githubOwner]
   * @param {string} [opts.githubRepo]
   * @param {string} [opts.githubApiBaseUrl]
   * @param {string[]} [opts.allowedHosts]
   */
  constructor({
    channel = 'beta',
    currentVersion = brand.VERSION || '0.1.0',
    stagingDir = null,
    verifier = null,
    broadcast = () => {},
    logger = console,
    githubOwner = process.env.BARQ_GITHUB_OWNER || DEFAULT_GITHUB_OWNER,
    githubRepo = process.env.BARQ_GITHUB_REPO || DEFAULT_GITHUB_REPO,
    githubApiBaseUrl = process.env.BARQ_GITHUB_API_BASE_URL || GITHUB_API_BASE_URL,
    allowedHosts = [],
  } = {}) {
    this.channel = channel;
    this.currentVersion = currentVersion;
    this.stagingDir = stagingDir;
    this.verifier = verifier || new SignatureVerifier();
    this.broadcast = broadcast;
    this.logger = logger;

    this.githubOwner = githubOwner;
    this.githubRepo = githubRepo;
    this.githubApiBaseUrl = githubApiBaseUrl;
    this.allowedHosts = new Set([...APPROVED_REDIRECT_HOSTS, ...allowedHosts]);

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
   * Checks whether a hostname is in the approved host allowlist.
   * @param {string} hostname
   * @param {Set<string>} [customAllowed]
   * @returns {boolean}
   */
  _isHostAllowed(hostname, customAllowed = new Set()) {
    if (!hostname) return false;
    const lower = hostname.toLowerCase();
    if (this.allowedHosts.has(lower) || customAllowed.has(lower)) return true;
    if (lower.endsWith('.github.com') || lower.endsWith('.githubusercontent.com')) return true;
    return false;
  }

  /**
   * Securely performs an HTTPS GET request enforcing timeouts, size bounds, and hop-by-hop redirect security.
   * @param {string} targetUrl
   * @param {number} maxBytes
   * @param {object} [opts]
   * @returns {Promise<Buffer>}
   */
  async _fetchHttps(targetUrl, maxBytes, opts = {}) {
    const {
      redirectCount = 0,
      visitedUrls = new Set(),
      allowedHosts = new Set(),
      allowInsecureHttp = false,
      headers = {},
    } = opts;

    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new URL(targetUrl);
      } catch (err) {
        return reject(new Error(`Invalid URL "${targetUrl}": ${err.message}`));
      }

      // 1. Strict Protocol Validation
      if (parsedUrl.protocol !== 'https:' && !allowInsecureHttp) {
        return reject(new Error(`Insecure protocol "${parsedUrl.protocol}" rejected. Update client requires HTTPS.`));
      }

      // 2. Strict Host Allowlist Validation
      if (!this._isHostAllowed(parsedUrl.hostname, allowedHosts) && !allowInsecureHttp) {
        return reject(new Error(`Unapproved redirect host rejected: "${parsedUrl.hostname}".`));
      }

      // 3. Redirect Loop Protection
      if (visitedUrls.has(targetUrl)) {
        return reject(new Error(`Redirect loop detected at "${targetUrl}".`));
      }
      visitedUrls.add(targetUrl);

      // 4. Maximum Hop Limit
      if (redirectCount > MAX_REDIRECT_HOPS) {
        return reject(new Error(`Maximum redirect limit of ${MAX_REDIRECT_HOPS} hops exceeded.`));
      }

      const client = parsedUrl.protocol === 'http:' ? http : https;
      const requestHeaders = {
        'User-Agent': `BARQ-Downloader/${this.currentVersion} (Windows x64)`,
        Accept: 'application/vnd.github.v3+json, application/json, */*',
        ...headers,
      };

      const req = client.get(parsedUrl, { headers: requestHeaders, timeout: CONNECT_TIMEOUT_MS }, (res) => {
        // Handle HTTP Redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, targetUrl).toString();
          } catch (e) {
            return reject(new Error(`Malformed redirect Location header: "${res.headers.location}".`));
          }

          // Reject HTTPS to HTTP downgrade
          if (!allowInsecureHttp && !nextUrl.startsWith('https://')) {
            return reject(new Error(`Insecure redirect to HTTP rejected: "${nextUrl}".`));
          }

          // Strip sensitive credentials on cross-origin redirects
          const nextHeaders = { ...requestHeaders };
          try {
            if (new URL(nextUrl).origin !== parsedUrl.origin) {
              delete nextHeaders.Authorization;
              delete nextHeaders.authorization;
              delete nextHeaders.Cookie;
              delete nextHeaders.cookie;
            }
          } catch {}

          return this._fetchHttps(nextUrl, maxBytes, {
            redirectCount: redirectCount + 1,
            visitedUrls,
            allowedHosts,
            allowInsecureHttp,
            headers: nextHeaders,
          }).then(resolve, reject);
        }

        // Handle GitHub API Rate Limits
        if ((res.statusCode === 403 || res.statusCode === 429) && (res.headers['x-ratelimit-remaining'] === '0' || String(res.statusMessage).toLowerCase().includes('rate'))) {
          return reject(new Error('GitHub API rate limit exceeded. Please try again later.'));
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
   * Securely streams an artifact download directly to disk with redirect handling, size bounds, and SHA-256 calculation.
   */
  async _downloadFileHttps(targetUrl, destPath, expectedSize, opts = {}) {
    const {
      redirectCount = 0,
      visitedUrls = new Set(),
      allowedHosts = new Set(),
      allowInsecureHttp = false,
      headers = {},
      onProgress = () => {},
    } = opts;

    let parsedUrl;
    try {
      parsedUrl = new URL(targetUrl);
    } catch (err) {
      throw new Error(`Invalid download URL "${targetUrl}": ${err.message}`);
    }

    if (parsedUrl.protocol !== 'https:' && !allowInsecureHttp) {
      throw new Error(`Insecure protocol "${parsedUrl.protocol}" rejected. Update client requires HTTPS.`);
    }

    if (!this._isHostAllowed(parsedUrl.hostname, allowedHosts) && !allowInsecureHttp) {
      throw new Error(`Unapproved redirect host rejected: "${parsedUrl.hostname}".`);
    }

    if (visitedUrls.has(targetUrl)) {
      throw new Error(`Redirect loop detected at "${targetUrl}".`);
    }
    visitedUrls.add(targetUrl);

    if (redirectCount > MAX_REDIRECT_HOPS) {
      throw new Error(`Maximum redirect limit of ${MAX_REDIRECT_HOPS} hops exceeded.`);
    }

    return new Promise((resolve, reject) => {
      const client = parsedUrl.protocol === 'http:' ? http : https;
      const requestHeaders = {
        'User-Agent': `BARQ-Downloader/${this.currentVersion} (Windows x64)`,
        ...headers,
      };

      const outStream = fs.createWriteStream(destPath, { mode: 0o700 });
      const hashStream = crypto.createHash('sha256');
      let downloaded = 0;

      const req = client.get(parsedUrl, { headers: requestHeaders, timeout: CONNECT_TIMEOUT_MS }, (res) => {
        // Handle Redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          outStream.close();
          try { fs.rmSync(destPath, { force: true }); } catch {}

          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, targetUrl).toString();
          } catch (e) {
            return reject(new Error(`Malformed redirect Location header: "${res.headers.location}".`));
          }

          if (!allowInsecureHttp && !nextUrl.startsWith('https://')) {
            return reject(new Error(`Insecure redirect to HTTP rejected: "${nextUrl}".`));
          }

          const nextHeaders = { ...requestHeaders };
          try {
            if (new URL(nextUrl).origin !== parsedUrl.origin) {
              delete nextHeaders.Authorization;
              delete nextHeaders.authorization;
              delete nextHeaders.Cookie;
              delete nextHeaders.cookie;
            }
          } catch {}

          return this._downloadFileHttps(nextUrl, destPath, expectedSize, {
            redirectCount: redirectCount + 1,
            visitedUrls,
            allowedHosts,
            allowInsecureHttp,
            headers: nextHeaders,
            onProgress,
          }).then(resolve, reject);
        }

        if (res.statusCode !== 200) {
          outStream.close();
          try { fs.rmSync(destPath, { force: true }); } catch {}
          return reject(new Error(`Failed to download artifact: HTTP ${res.statusCode}`));
        }

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (downloaded > MAX_ARTIFACT_SIZE) {
            req.destroy();
            outStream.close();
            try { fs.rmSync(destPath, { force: true }); } catch {}
            return reject(new Error(`Artifact exceeded maximum size limit of ${MAX_ARTIFACT_SIZE} bytes.`));
          }
          hashStream.update(chunk);
          onProgress(downloaded, expectedSize);
        });

        res.pipe(outStream);

        outStream.on('finish', () => {
          const actualDigest = hashStream.digest('hex');
          resolve({ downloaded, actualDigest });
        });

        outStream.on('error', (err) => {
          try { fs.rmSync(destPath, { force: true }); } catch {}
          reject(err);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        outStream.close();
        try { fs.rmSync(destPath, { force: true }); } catch {}
        reject(new Error('Artifact download timed out.'));
      });

      req.on('error', (err) => {
        outStream.close();
        try { fs.rmSync(destPath, { force: true }); } catch {}
        reject(err);
      });

      this.activeRequest = req;
    });
  }

  /**
   * Checks for updates against GitHub Releases or custom/direct endpoints.
   * @param {object} [opts]
   * @returns {Promise<object>} Status object
   */
  async checkForUpdates(opts = {}) {
    this._setState('checking');
    this.availableRelease = null;
    this.stagedArtifact = null;

    try {
      // Branch A: Direct Manifest Endpoint (Legacy / Direct URL / Test Mocks)
      if (opts.customManifestUrl || opts.directManifest) {
        return await this._checkDirectManifest(opts);
      }

      // Branch B: GitHub Releases Integration (Primary zero-cost distribution)
      return await this._checkGitHubReleases(opts);
    } catch (err) {
      this.logger.error('Update check failed:', err);
      this._setState('failed', err.message);
      return this.getStatus();
    } finally {
      this.activeRequest = null;
    }
  }

  /**
   * Internal checker for GitHub Releases.
   */
  async _checkGitHubReleases(opts) {
    const owner = opts.githubOwner || this.githubOwner;
    const repo = opts.githubRepo || this.githubRepo;
    const apiUrl = opts.releasesApiUrl || `${this.githubApiBaseUrl}/repos/${owner}/${repo}/releases`;

    this.logger.info(`Checking GitHub Releases for ${owner}/${repo} (${this.channel} channel)...`);

    // 1. Fetch releases list from GitHub API
    let releases;
    if (opts.mockReleases) {
      releases = opts.mockReleases;
    } else {
      const releasesBuf = await this._fetchHttps(apiUrl, MAX_MANIFEST_SIZE, {
        allowedHosts: opts.allowedHosts,
        allowInsecureHttp: Boolean(opts.allowInsecureHttp),
      });
      try {
        releases = JSON.parse(releasesBuf.toString('utf8'));
      } catch (err) {
        throw new Error(`Failed to parse GitHub Releases API response: ${err.message}`);
      }
    }

    if (!Array.isArray(releases) || releases.length === 0) {
      this.logger.info(`No releases found on GitHub repository ${owner}/${repo}.`);
      this._setState('no-update');
      return this.getStatus();
    }

    // 2. Filter candidate releases by Channel & Validity
    const eligibleReleases = [];

    for (const rel of releases) {
      // Reject drafts
      if (rel.draft === true) continue;

      // Extract SemVer from tag
      if (!rel.tag_name || typeof rel.tag_name !== 'string') continue;
      const cleanTag = rel.tag_name.replace(/^v/, '');
      const parsedVer = ManifestValidator.parseSemver(cleanTag);
      if (!parsedVer) {
        this.logger.warn(`Skipping release with invalid SemVer tag: "${rel.tag_name}".`);
        continue;
      }

      // Channel-specific selection policy:
      if (this.channel === 'stable') {
        // Stable channel strictly requires non-prerelease
        if (rel.prerelease === true || parsedVer.prerelease !== null) continue;
      } else if (this.channel === 'beta') {
        // Beta channel accepts prerelease builds or newer stable builds
      }

      eligibleReleases.push({ ...rel, cleanTag });
    }

    if (eligibleReleases.length === 0) {
      this.logger.info(`No eligible releases found for channel "${this.channel}".`);
      this._setState('no-update');
      return this.getStatus();
    }

    // Sort descending by SemVer to select newest release
    eligibleReleases.sort((a, b) => ManifestValidator.compareSemver(b.cleanTag, a.cleanTag));
    const selectedRelease = eligibleReleases[0];

    // 3. Locate release-manifest.json and release-manifest.json.sig assets
    const assets = Array.isArray(selectedRelease.assets) ? selectedRelease.assets : [];
    const manifestAsset = assets.find((a) => a.name === 'release-manifest.json');
    const sigAsset = assets.find((a) => a.name === 'release-manifest.json.sig');

    if (!manifestAsset || !sigAsset) {
      throw new Error(`Selected release "${selectedRelease.tag_name}" is missing required release-manifest.json or release-manifest.json.sig asset.`);
    }

    // 4. Fetch manifest and detached signature
    const manifestBuf = await this._fetchHttps(manifestAsset.browser_download_url, MAX_MANIFEST_SIZE, {
      allowedHosts: opts.allowedHosts,
      allowInsecureHttp: Boolean(opts.allowInsecureHttp),
    });
    const rawManifestStr = manifestBuf.toString('utf8');

    let signatureStr;
    if (opts.mockSignature) {
      signatureStr = String(opts.mockSignature);
    } else {
      const sigBuf = await this._fetchHttps(sigAsset.browser_download_url, 4096, {
        allowedHosts: opts.allowedHosts,
        allowInsecureHttp: Boolean(opts.allowInsecureHttp),
      });
      signatureStr = sigBuf.toString('utf8').trim();
    }

    this._setState('verifying-manifest');

    // 5. Cryptographic Signature Verification
    const sigCheck = this.verifier.verify(rawManifestStr, signatureStr);
    if (!sigCheck.verified) {
      throw new Error(`Release manifest authenticity verification failed: ${sigCheck.error}`);
    }

    // 6. Strict Schema & Semantic Version Validation
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

    // 7. Locate target artifact for win32-x64
    const winX64 = manifestData.platforms && manifestData.platforms['win32-x64'];
    if (!winX64) {
      throw new Error('Release manifest does not provide artifacts for platform "win32-x64".');
    }
    const targetArtifact = winX64.installer || winX64.portable;
    if (!targetArtifact) {
      throw new Error('Platform "win32-x64" does not contain installer or portable artifact.');
    }

    // Resolve direct asset download URL from GitHub release assets
    const matchingAsset = assets.find((a) => a.name === targetArtifact.filename);
    const artifactDownloadUrl = matchingAsset
      ? matchingAsset.browser_download_url
      : `https://github.com/${owner}/${repo}/releases/download/${selectedRelease.tag_name}/${targetArtifact.filename}`;

    this.availableRelease = {
      version: manifestData.version,
      tagName: selectedRelease.tag_name,
      publishedAt: manifestData.publishedAt || selectedRelease.published_at,
      releaseNotes: selectedRelease.body || manifestData.releaseNotes || 'Public beta release update.',
      artifact: targetArtifact,
      artifactType: winX64.installer ? 'installer' : 'portable',
      artifactDownloadUrl,
      manifestUrl: manifestAsset.browser_download_url,
    };

    this._setState('update-available');
    return this.getStatus();
  }

  /**
   * Internal checker for direct manifest endpoints (legacy/custom/test server).
   */
  async _checkDirectManifest(opts) {
    const manifestUrl = opts.customManifestUrl || process.env.BARQ_UPDATE_ENDPOINT || `${DEFAULT_UPDATE_BASE_URL}/${this.channel}/release-manifest.json`;
    const sigUrl = `${manifestUrl}.sig`;

    const directAllowedHosts = new Set(opts.allowedHosts || []);
    try {
      directAllowedHosts.add(new URL(manifestUrl).hostname.toLowerCase());
    } catch {}

    this.logger.info(`Checking for updates from direct URL: ${manifestUrl}`);

    const manifestBuf = await this._fetchHttps(manifestUrl, MAX_MANIFEST_SIZE, {
      allowedHosts: directAllowedHosts,
      allowInsecureHttp: Boolean(opts.allowInsecureHttp),
    });
    const rawManifestStr = manifestBuf.toString('utf8');

    let signatureStr;
    if (opts.mockSignature) {
      signatureStr = String(opts.mockSignature);
    } else {
      const sigBuf = await this._fetchHttps(sigUrl, 4096, {
        allowedHosts: directAllowedHosts,
        allowInsecureHttp: Boolean(opts.allowInsecureHttp),
      });
      signatureStr = sigBuf.toString('utf8').trim();
    }

    this._setState('verifying-manifest');

    const sigCheck = this.verifier.verify(rawManifestStr, signatureStr);
    if (!sigCheck.verified) {
      throw new Error(`Release manifest authenticity verification failed: ${sigCheck.error}`);
    }

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
      artifactDownloadUrl: null, // will resolve relative to manifestUrl
      manifestUrl,
    };

    this._setState('update-available');
    return this.getStatus();
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
      const artifactUrl = opts.artifactUrl || this.availableRelease.artifactDownloadUrl || (
        opts.artifactBaseUrl
          ? `${opts.artifactBaseUrl}/${artifactMeta.filename}`
          : new URL(artifactMeta.filename, this.availableRelease.manifestUrl).toString()
      );

      const downloadAllowedHosts = new Set(opts.allowedHosts || []);
      try {
        downloadAllowedHosts.add(new URL(artifactUrl).hostname.toLowerCase());
      } catch {}

      this.logger.info(`Downloading update artifact from ${artifactUrl} to ${tempFilePath}`);

      // Stream download to temporary staging file with strict redirect handling
      await this._downloadFileHttps(artifactUrl, tempFilePath, artifactMeta.size, {
        allowedHosts: downloadAllowedHosts,
        allowInsecureHttp: Boolean(opts.allowInsecureHttp),
        onProgress: (downloaded, total) => {
          this.downloadProgress.downloadedBytes = downloaded;
          this.downloadProgress.percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0;
          this.broadcast('updater:status-changed', this.getStatus());
        },
      });

      this._setState('verifying-artifact');

      // 1. Verify byte size
      const stat = fs.statSync(tempFilePath);
      if (stat.size !== artifactMeta.size) {
        throw new Error(`Artifact size mismatch: expected ${artifactMeta.size} bytes, got ${stat.size} bytes.`);
      }

      // 2. Verify SHA-256 Digest using constant-time comparison
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

module.exports = {
  UpdateService,
  DEFAULT_UPDATE_BASE_URL,
  DEFAULT_GITHUB_OWNER,
  DEFAULT_GITHUB_REPO,
  GITHUB_API_BASE_URL,
  APPROVED_REDIRECT_HOSTS,
  MAX_MANIFEST_SIZE,
  MAX_ARTIFACT_SIZE,
  MAX_REDIRECT_HOPS,
};
