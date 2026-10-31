'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');

const { NativePipeServer, DEFAULT_PIPE_NAME, PROTOCOL_VERSION, MAX_MESSAGE_SIZE } = require('../src/main/native-pipe-server');
const { RegistryManager } = require('../native-host/registry-manager');
const { BarqDatabase } = require('../src/main/db/database');
const { DownloadsRepo, EventsRepo } = require('../src/main/db/downloads-repo');
const { SettingsRepo } = require('../src/main/db/settings-repo');
const { buildSchema } = require('../src/main/settings-schema');
const { DownloadManager } = require('../src/main/engine/DownloadManager');
const { createTestServer } = require('./fixtures/test-server');

const TEST_PIPE_NAME = `barq-test-pipe-${process.pid}-${Date.now()}`;
let serverInstance = null;
let baseUrl = '';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test.before(async () => {
  serverInstance = createTestServer();
  baseUrl = await serverInstance.start();
});

test.after(async () => {
  if (serverInstance) await serverInstance.stop();
});

// Helper to create an isolated session with real SQLite and DownloadManager
function createIsolatedSession(customDir = null) {
  const dir = customDir || path.join(__dirname, '..', 'dev-data', `test-m4-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'test.db');
  const db = new BarqDatabase(dbPath).open();
  const schema = buildSchema({ defaultDownloadDir: dir });
  const settingsRepo = new SettingsRepo(db, schema);
  const downloadsRepo = new DownloadsRepo(db);
  const eventsRepo = new EventsRepo(db);
  const manager = new DownloadManager({
    downloadsRepo,
    settingsRepo,
    eventsRepo,
    logger: { info() {}, warn() {}, error() {} },
  });
  return { dir, db, downloadsRepo, settingsRepo, eventsRepo, manager };
}

// Helper to send a request over Named Pipe / local socket
function sendPipeRequest(pipePath, message) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let response = '';

    socket.setTimeout(4000);

    socket.on('connect', () => {
      socket.write(JSON.stringify(message) + '\n');
    });

    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\n')) {
        socket.end();
        try {
          resolve(JSON.parse(response.trim()));
        } catch (e) {
          reject(e);
        }
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Pipe request timeout'));
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });
}

test('BARQ Downloader — Milestone 4 Browser Extension & Native Host Suite', async (t) => {
  // ===========================================================================
  // 1. EXTENSION MANIFEST V3 & ASSETS VALIDATION
  // ===========================================================================
  await t.test('1.1: Extension manifest complies with Manifest V3 and security constraints', () => {
    const manifestPath = path.join(__dirname, '..', 'browser-extension', 'manifest.json');
    assert.equal(fs.existsSync(manifestPath), true, 'manifest.json must exist');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.manifest_version, 3, 'Must be Manifest V3');
    assert.equal(manifest.name, 'BARQ Downloader');
    assert.ok(manifest.key, 'Key must be present to stabilize extension ID in development');

    // Permissions check: only minimal permissions, no broad host permissions
    const perms = manifest.permissions;
    assert.ok(perms.includes('contextMenus'), 'Requires contextMenus');
    assert.ok(perms.includes('nativeMessaging'), 'Requires nativeMessaging');
    assert.ok(perms.includes('storage'), 'Requires storage');
    assert.ok(perms.includes('activeTab'), 'Requires activeTab');
    assert.equal(manifest.host_permissions, undefined, 'Must NOT request broad host_permissions');

    // Action and icons
    assert.ok(manifest.action.default_popup, 'Action popup must be declared');
    for (const size of ['16', '48', '128']) {
      const iconPath = path.join(__dirname, '..', 'browser-extension', manifest.icons[size]);
      assert.equal(fs.existsSync(iconPath), true, `Icon size ${size} must physically exist on disk`);
      const iconBytes = fs.readFileSync(iconPath);
      assert.ok(iconBytes.length > 50, `Icon size ${size} must be non-empty`);
      // Validate PNG signature
      assert.equal(iconBytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Must be valid PNG');
    }
  });

  // ===========================================================================
  // 2. NATIVE MESSAGING PROTOCOL FRAMING
  // ===========================================================================
  await t.test('2.1: Native host length-prefix wire framing handles 4-byte uint32 LE accurately', () => {
    const payload = { hello: 'world', test: 123 };
    const jsonStr = JSON.stringify(payload);
    const jsonBuf = Buffer.from(jsonStr, 'utf8');

    // Encode length
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(jsonBuf.length, 0);

    const fullMessage = Buffer.concat([lenBuf, jsonBuf]);

    // Decode length
    const readLen = fullMessage.readUInt32LE(0);
    assert.equal(readLen, jsonBuf.length);

    const readPayload = JSON.parse(fullMessage.subarray(4, 4 + readLen).toString('utf8'));
    assert.deepEqual(readPayload, payload);
  });

  // ===========================================================================
  // 3. NAMED PIPE SERVER & AUTHENTICATED LOCAL IPC
  // ===========================================================================
  await t.test('3.1: NativePipeServer starts, generates auth secret, and responds to get_status', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-status`,
    });

    try {
      await pipeServer.start();
      assert.equal(pipeServer.isRunning, true);
      assert.ok(fs.existsSync(pipeServer.tokenFilePath), 'ipc-secret.dat must exist on disk');

      const secret = fs.readFileSync(pipeServer.tokenFilePath, 'utf8').trim();
      assert.equal(secret.length, 64, 'Token must be 64 hex characters (256-bit)');

      // Send valid authenticated status request
      const res = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'req-test-status-1',
        operation: 'get_status',
      });

      assert.equal(res.ok, true);
      assert.equal(res.status, 'ready');
      assert.equal(res.version, '0.1.0');
      assert.equal(res.requestId, 'req-test-status-1');
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  await t.test('3.2: Rejects unauthorized pipe requests with missing or invalid secret', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-auth`,
    });

    try {
      await pipeServer.start();

      // Missing secret
      const resNoSecret = await sendPipeRequest(pipeServer.pipePath, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'req-bad-1',
        operation: 'get_status',
      });
      assert.equal(resNoSecret.ok, false);
      assert.equal(resNoSecret.code, 'AUTH_FAILED');

      // Invalid secret
      const resBadSecret = await sendPipeRequest(pipeServer.pipePath, {
        secret: '0000000000000000000000000000000000000000000000000000000000000000',
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'req-bad-2',
        operation: 'get_status',
      });
      assert.equal(resBadSecret.ok, false);
      assert.equal(resBadSecret.code, 'AUTH_FAILED');
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  await t.test('3.3: Rejects unsupported operations and malformed protocol versions', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-ops`,
    });

    try {
      await pipeServer.start();
      const secret = fs.readFileSync(pipeServer.tokenFilePath, 'utf8').trim();

      // Unsupported protocol version
      const resBadProto = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: 999,
        requestId: 'req-bad-proto',
        operation: 'get_status',
      });
      assert.equal(resBadProto.ok, false);
      assert.equal(resBadProto.code, 'UNSUPPORTED_PROTOCOL');

      // Unknown operation
      const resBadOp = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'req-bad-op',
        operation: 'execute_shell_command',
        payload: { command: 'calc.exe' },
      });
      assert.equal(resBadOp.ok, false);
      assert.equal(resBadOp.code, 'UNKNOWN_OPERATION');
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  // ===========================================================================
  // 4. SECURITY & INPUT VALIDATION
  // ===========================================================================
  await t.test('4.1: Rejects dangerous protocols (file:, javascript:, data:, ftp:) from browser', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-security`,
    });

    try {
      await pipeServer.start();
      const secret = fs.readFileSync(pipeServer.tokenFilePath, 'utf8').trim();

      const dangerousUrls = [
        'file:///C:/Windows/System32/calc.exe',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'ftp://ftp.example.com/file.zip',
        'http://',
        'not-a-url',
      ];

      for (const dangerous of dangerousUrls) {
        const res = await sendPipeRequest(pipeServer.pipePath, {
          secret,
          protocolVersion: PROTOCOL_VERSION,
          requestId: `req-sec-${Math.random()}`,
          operation: 'submit_download',
          payload: { url: dangerous },
        });
        assert.equal(res.ok, false, `Must reject ${dangerous}`);
        assert.equal(res.code, 'INVALID_URL');
      }
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  await t.test('4.2: Strips directory traversal in filename hints from browser', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-traversal`,
    });

    try {
      await pipeServer.start();
      const secret = fs.readFileSync(pipeServer.tokenFilePath, 'utf8').trim();

      const res = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'req-traversal-1',
        operation: 'submit_download',
        payload: {
          url: `${baseUrl}/1mb`,
          source: 'browser_context_menu',
          filenameHint: '../../../../Windows/win.ini',
        },
      });

      assert.equal(res.ok, true);
      assert.equal(res.status, 'accepted');
      assert.equal(res.filename, 'win.ini', 'Traversal prefix must be stripped completely');
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  // ===========================================================================
  // 5. IDEMPOTENCY & DUPLICATE SUBMISSION MITIGATION
  // ===========================================================================
  await t.test('5.1: Idempotency controls prevent duplicate downloads on rapid retries with same requestId', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-idempotency`,
    });

    try {
      await pipeServer.start();
      const secret = fs.readFileSync(pipeServer.tokenFilePath, 'utf8').trim();
      const testReqId = 'req-unique-idempotency-key';

      // First submission
      const res1 = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: PROTOCOL_VERSION,
        requestId: testReqId,
        operation: 'submit_download',
        payload: { url: `${baseUrl}/1mb`, filenameHint: 'idem.bin' },
      });
      assert.equal(res1.ok, true);
      assert.equal(res1.status, 'accepted');

      // Second immediate submission with same requestId
      const res2 = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: PROTOCOL_VERSION,
        requestId: testReqId,
        operation: 'submit_download',
        payload: { url: `${baseUrl}/1mb`, filenameHint: 'idem.bin' },
      });
      assert.equal(res2.ok, true);
      assert.equal(res2.idempotencyReplay, true, 'Second submission must return cached result');
      assert.equal(res1.downloadId, res2.downloadId, 'Must not create a new download record');

      // Check SQLite table has only 1 record
      const downloads = db.prepare('SELECT COUNT(*) AS count FROM downloads').get();
      assert.equal(downloads.count, 1, 'Only 1 download record should exist in database');
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  // ===========================================================================
  // 6. END-TO-END BROWSER DOWNLOAD EXECUTION & SHA-256 MATCH
  // ===========================================================================
  await t.test('6.1: Submitting URL via Native Pipe downloads completely with bit-for-bit SHA-256 match', async () => {
    const { dir, db, manager } = createIsolatedSession();
    const pipeServer = new NativePipeServer({
      dataDir: dir,
      downloadManager: manager,
      pipeName: `${TEST_PIPE_NAME}-e2e`,
    });

    try {
      await pipeServer.start();
      const secret = fs.readFileSync(pipeServer.tokenFilePath, 'utf8').trim();

      const res = await sendPipeRequest(pipeServer.pipePath, {
        secret,
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'req-e2e-download-1',
        operation: 'submit_download',
        payload: {
          url: `${baseUrl}/1mb`,
          source: 'chrome_extension',
          filenameHint: 'browser-downloaded.bin',
        },
      });

      assert.equal(res.ok, true);
      assert.equal(res.status, 'accepted');
      assert.ok(res.downloadId > 0);

      // Wait for task to finish download
      const task = manager.tasks.get(res.downloadId);
      assert.ok(task, 'Task must exist in DownloadManager');

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Download timed out')), 10000);
        task.on('state-changed', (s) => {
          if (s.state === 'completed') {
            clearTimeout(timeout);
            resolve();
          } else if (s.state === 'failed') {
            clearTimeout(timeout);
            reject(new Error(`Download failed: ${task.record.error_message}`));
          }
        });
      });

      // Verify file on disk
      const filePath = path.join(dir, 'browser-downloaded.bin');
      assert.equal(fs.existsSync(filePath), true, 'File must exist in destination folder');

      const fileData = fs.readFileSync(filePath);
      assert.equal(fileData.length, serverInstance.buf1mb.length);
      assert.equal(sha256(fileData), serverInstance.hash1mb, 'Downloaded file SHA-256 must match source bit-for-bit');

      // Verify SQLite state
      const row = db.prepare('SELECT status, downloaded_bytes, total_bytes FROM downloads WHERE id = ?').get(res.downloadId);
      assert.equal(row.status, 'completed');
      assert.equal(row.downloaded_bytes, serverInstance.buf1mb.length);
    } finally {
      await pipeServer.stop();
      await manager.shutdown();
      db.close();
    }
  });

  // ===========================================================================
  // 7. REGISTRY REGISTRATION & UNREGISTRATION
  // ===========================================================================
  await t.test('7.1: RegistryManager registers and unregisters Native Messaging Host cleanly', () => {
    // 1. Register
    const regResult = RegistryManager.register();
    assert.equal(regResult.ok, true, 'Registration must succeed');

    const status = RegistryManager.checkStatus();
    assert.equal(status.chromeRegistered, true, 'Chrome must be registered');
    assert.equal(status.edgeRegistered, true, 'Edge must be registered');
    assert.equal(status.manifestExists, true, 'Manifest must exist');

    // 2. Unregister
    const unregResult = RegistryManager.unregister();
    assert.equal(unregResult.ok, true, 'Unregistration must succeed');

    const unregStatus = RegistryManager.checkStatus();
    assert.equal(unregStatus.chromeRegistered, false, 'Chrome key must be removed');
    assert.equal(unregStatus.edgeRegistered, false, 'Edge key must be removed');

    // 3. Re-register for subsequent application use
    RegistryManager.register();
  });
});
