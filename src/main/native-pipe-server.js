'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateDownloadUrl, sanitizeFilename } = require('./security');

const DEFAULT_PIPE_NAME = 'barq-downloader-ipc';
const MAX_MESSAGE_SIZE = 1048576; // 1 MiB limit
const IDEMPOTENCY_TTL_MS = 60000; // 60 seconds
const PROTOCOL_VERSION = 1;

/**
 * Returns the platform-specific pipe or domain socket path.
 * Windows: \\.\pipe\<pipeName>
 * POSIX: /tmp/<pipeName>.sock
 */
function getPipePath(pipeName = DEFAULT_PIPE_NAME) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\${pipeName}`;
  }
  return path.join('/tmp', `${pipeName}.sock`);
}

/**
 * Windows Local Named Pipe Server providing authenticated IPC between
 * BARQ Downloader Desktop and the Chrome/Edge Native Messaging Host.
 */
class NativePipeServer {
  /**
   * @param {object} opts
   * @param {string} opts.dataDir Directory where auth token is stored with user ACLs
   * @param {import('./engine/DownloadManager').DownloadManager} opts.downloadManager
   * @param {import('./logger').createLogger} opts.logger
   * @param {() => Electron.BrowserWindow|null} [opts.getMainWindow]
   * @param {string} [opts.pipeName]
   */
  constructor({ dataDir, downloadManager, logger, getMainWindow = null, pipeName = DEFAULT_PIPE_NAME }) {
    this.dataDir = dataDir;
    this.downloadManager = downloadManager;
    this.logger = logger || { info() {}, warn() {}, error() {} };
    this.getMainWindow = getMainWindow || (() => null);
    this.pipeName = pipeName;
    this.pipePath = getPipePath(pipeName);

    this.tokenFilePath = path.join(dataDir, 'ipc-secret.dat');
    this.authToken = null;
    this.server = null;
    this.isRunning = false;

    // Cache to prevent duplicate submissions on double-clicks or retries
    this.recentRequests = new Map(); // requestId -> { result, timestamp }
  }

  /**
   * Generates a dynamic cryptographically secure authentication token,
   * writes it to restricted storage, and starts listening on the named pipe.
   */
  async start() {
    if (this.isRunning) return;

    // 1. Generate 256-bit random auth token
    this.authToken = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.tokenFilePath, this.authToken, { mode: 0o600, encoding: 'utf8' });

    // On Windows, set restrictive permissions if possible (current user only)
    this.logger.info('NativePipeServer: Generated dynamic auth secret', {
      tokenPath: this.tokenFilePath,
      pipePath: this.pipePath,
    });

    // 2. Create Named Pipe / Local Socket Server
    return new Promise((resolve, reject) => {
      // Clean up legacy socket file on Unix if it lingered
      if (process.platform !== 'win32' && fs.existsSync(this.pipePath)) {
        try { fs.unlinkSync(this.pipePath); } catch {}
      }

      this.server = net.createServer((socket) => {
        this._handleConnection(socket);
      });

      this.server.on('error', (err) => {
        this.logger.error('NativePipeServer error:', err);
        if (!this.isRunning) reject(err);
      });

      this.server.listen(this.pipePath, () => {
        this.isRunning = true;
        this.logger.info(`NativePipeServer: Listening on ${this.pipePath}`);
        resolve();
      });
    });
  }

  /**
   * Shuts down the Named Pipe server and revokes the auth token.
   */
  async stop() {
    if (!this.isRunning) return;
    this.isRunning = false;

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this._cleanupTokenFile();
          this.logger.info('NativePipeServer: Stopped.');
          resolve();
        });
      } else {
        this._cleanupTokenFile();
        resolve();
      }
    });
  }

  _cleanupTokenFile() {
    try {
      if (fs.existsSync(this.tokenFilePath)) {
        fs.unlinkSync(this.tokenFilePath);
      }
    } catch {}
  }

  /**
   * Handles incoming client connection from Native Messaging host.
   * Enforces framing, size limit, authentication, and operation validation.
   */
  _handleConnection(socket) {
    let buffer = '';

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');

      if (Buffer.byteLength(buffer, 'utf8') > MAX_MESSAGE_SIZE) {
        this.logger.warn('NativePipeServer: Message exceeded 1 MiB limit, disconnecting.');
        this._sendResponse(socket, {
          protocolVersion: PROTOCOL_VERSION,
          requestId: null,
          ok: false,
          code: 'OVERSIZED_MESSAGE',
          message: 'Message exceeds 1 MiB limit.',
        });
        socket.destroy();
        return;
      }

      // Process newline-delimited JSON frames
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;

        let request;
        try {
          request = JSON.parse(line);
        } catch {
          this._sendResponse(socket, {
            protocolVersion: PROTOCOL_VERSION,
            requestId: null,
            ok: false,
            code: 'INVALID_JSON',
            message: 'Request could not be parsed as valid JSON.',
          });
          continue;
        }

        const response = await this._processRequest(request);
        this._sendResponse(socket, response);
      }
    });

    socket.on('error', (err) => {
      this.logger.warn('NativePipeServer socket error:', err.message);
    });
  }

  /**
   * Processes an incoming parsed request.
   */
  async _processRequest(req) {
    // 1. Structure validation
    if (!req || typeof req !== 'object') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: null,
        ok: false,
        code: 'INVALID_REQUEST',
        message: 'Request must be a JSON object.',
      };
    }

    const { secret, protocolVersion, requestId, operation, payload } = req;

    // 2. Protocol version check
    if (protocolVersion !== PROTOCOL_VERSION) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: requestId || null,
        ok: false,
        code: 'UNSUPPORTED_PROTOCOL',
        message: `Unsupported protocol version ${protocolVersion}. Expected ${PROTOCOL_VERSION}.`,
      };
    }

    // 3. Request ID check
    if (!requestId || typeof requestId !== 'string' || requestId.length > 128) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: null,
        ok: false,
        code: 'INVALID_REQUEST_ID',
        message: 'requestId is required and must be a valid string.',
      };
    }

    // 4. Authentication Check
    if (!secret || typeof secret !== 'string') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: false,
        code: 'AUTH_FAILED',
        message: 'Authentication token missing.',
      };
    }

    const secretBuffer = Buffer.from(secret, 'utf8');
    const authBuffer = Buffer.from(this.authToken || '', 'utf8');

    if (secretBuffer.length !== authBuffer.length || !crypto.timingSafeEqual(secretBuffer, authBuffer)) {
      this.logger.warn('NativePipeServer: Authentication rejected (invalid token).');
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: false,
        code: 'AUTH_FAILED',
        message: 'Invalid authentication secret.',
      };
    }

    // 5. Idempotency check for repeated submissions (e.g. rapid double-clicks)
    this._pruneRecentRequests();
    if (this.recentRequests.has(requestId)) {
      const cached = this.recentRequests.get(requestId);
      return { ...cached.result, idempotencyReplay: true };
    }

    // 6. Handle Supported Operations
    let result;
    try {
      switch (operation) {
        case 'get_status': {
          const telemetry = this.downloadManager ? this.downloadManager.getGlobalTelemetry() : { activeTransfers: 0 };
          result = {
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            ok: true,
            status: 'ready',
            version: '0.1.0',
            activeTransfers: telemetry.activeTransfers || 0,
            message: 'BARQ Downloader is running and ready.',
          };
          break;
        }

        case 'submit_download': {
          result = await this._handleSubmitDownload(requestId, payload);
          break;
        }

        default: {
          result = {
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            ok: false,
            code: 'UNKNOWN_OPERATION',
            message: `Unsupported operation: ${operation}`,
          };
          break;
        }
      }
    } catch (err) {
      this.logger.error(`NativePipeServer operation ${operation} error:`, err);
      result = {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: false,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error while processing request.',
      };
    }

    // Cache successful result for idempotency window
    if (result.ok) {
      this.recentRequests.set(requestId, { result, timestamp: Date.now() });
    }

    return result;
  }

  /**
   * Validates and submits a new download via DownloadManager.
   */
  async _handleSubmitDownload(requestId, payload) {
    if (!payload || typeof payload !== 'object') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: false,
        code: 'INVALID_PAYLOAD',
        message: 'payload must be an object with url property.',
      };
    }

    const { url, source = 'browser_extension', filenameHint = null } = payload;

    // Validate URL scheme and safety
    const urlValidation = validateDownloadUrl(url);
    if (!urlValidation.ok) {
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        ok: false,
        code: 'INVALID_URL',
        message: urlValidation.error,
      };
    }

    // Sanitize filename hint if provided
    const safeHint = filenameHint ? sanitizeFilename(filenameHint) : null;

    // Submit to existing core DownloadManager
    this.logger.info(`NativePipeServer: Adding download from ${source}`, { url: urlValidation.url, hint: safeHint });
    const rec = await this.downloadManager.add({
      sourceUrl: urlValidation.url,
      filename: safeHint,
      destinationPath: null, // Uses configured default download dir
      startNow: true,
    });

    // Notify open Electron renderer window to update downloads view
    const win = this.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('downloads:changed', { action: 'added', id: rec.id });
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      requestId,
      ok: true,
      status: 'accepted',
      downloadId: rec.id,
      filename: rec.filename,
      message: `Download "${rec.filename}" added to BARQ Downloader.`,
    };
  }

  _sendResponse(socket, response) {
    if (socket.writable) {
      socket.write(JSON.stringify(response) + '\n');
    }
  }

  _pruneRecentRequests() {
    const now = Date.now();
    for (const [id, entry] of this.recentRequests) {
      if (now - entry.timestamp > IDEMPOTENCY_TTL_MS) {
        this.recentRequests.delete(id);
      }
    }
  }
}

module.exports = {
  NativePipeServer,
  DEFAULT_PIPE_NAME,
  MAX_MESSAGE_SIZE,
  PROTOCOL_VERSION,
  getPipePath,
};
