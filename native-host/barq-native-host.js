'use strict';

/**
 * BARQ Downloader — Chrome & Edge Native Messaging Host
 * برق ڈاؤنلوڈر — Speed at Every Click.
 *
 * Communicates with Chrome/Edge via standard input/output (4-byte length prefix)
 * and relays validated download requests to the running BARQ desktop app via
 * an authenticated Windows Named Pipe.
 *
 * NOTE: NEVER write to stdout except via sendNativeMessage()!
 * Diagnostic logs are written to stderr or the native-host log file.
 */

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_SIZE = 1048576; // 1 MiB limit
const PIPE_NAME = 'barq-downloader-ipc';
const PIPE_PATH = process.platform === 'win32'
  ? `\\\\.\\pipe\\${PIPE_NAME}`
  : path.join('/tmp', `${PIPE_NAME}.sock`);

// -----------------------------------------------------------------------------
// Logging Helper (Strictly stderr and file, NEVER stdout)
// -----------------------------------------------------------------------------
let logFileStream = null;
function initLogFile(logDir) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
    logFileStream = fs.createWriteStream(path.join(logDir, 'native-host.log'), { flags: 'a' });
  } catch {}
}

function log(level, message, meta = null) {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
  process.stderr.write(line);
  if (logFileStream) {
    try { logFileStream.write(line); } catch {}
  }
}

// -----------------------------------------------------------------------------
// Data Directory Resolution (locating BARQ's ipc-secret.dat)
// -----------------------------------------------------------------------------
function resolveSecretPath() {
  // 1. Explicit environment override
  if (process.env.BARQ_DATA_DIR) {
    const p = path.join(process.env.BARQ_DATA_DIR, 'ipc-secret.dat');
    if (fs.existsSync(p)) return p;
  }

  // 2. Development mode beside project root
  const devPath = path.resolve(__dirname, '..', 'dev-data', 'ipc-secret.dat');
  if (fs.existsSync(devPath)) return devPath;

  // 3. Portable data beside executable
  const portablePath = path.resolve(__dirname, '..', 'portable-data', 'ipc-secret.dat');
  if (fs.existsSync(portablePath)) return portablePath;

  // 4. Per-user LocalAppData on Windows
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
  if (localAppData) {
    const userPath = path.join(localAppData, 'BARQ Downloader', 'ipc-secret.dat');
    if (fs.existsSync(userPath)) return userPath;
  }

  // Default fallback check
  return devPath;
}

// Initialize file logging in same directory as secret or temp
try {
  const secretPath = resolveSecretPath();
  initLogFile(path.dirname(secretPath));
} catch {}

// -----------------------------------------------------------------------------
// Native Messaging Wire Protocol (4-byte little-endian message framing)
// -----------------------------------------------------------------------------

/**
 * Sends a framed JSON message to stdout.
 * Formatted as: [4-byte uint32 little-endian length] + [UTF-8 JSON string]
 */
function sendNativeMessage(obj) {
  const jsonStr = JSON.stringify(obj);
  const jsonBytes = Buffer.from(jsonStr, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(jsonBytes.length, 0);

  process.stdout.write(lenBuf);
  process.stdout.write(jsonBytes);
}

/**
 * Relays request to BARQ Desktop Named Pipe Server.
 */
function sendToBarqApp(request) {
  return new Promise((resolve) => {
    const secretPath = resolveSecretPath();

    if (!fs.existsSync(secretPath)) {
      log('warn', 'Secret file not found; BARQ is not running', { secretPath });
      return resolve({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId || 'unknown',
        ok: false,
        status: 'unavailable',
        code: 'BARQ_NOT_RUNNING',
        message: 'BARQ Downloader is not running. Please launch BARQ Downloader.',
      });
    }

    let secret;
    try {
      secret = fs.readFileSync(secretPath, 'utf8').trim();
    } catch (err) {
      log('error', 'Failed to read secret file', { error: err.message });
      return resolve({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId || 'unknown',
        ok: false,
        status: 'error',
        code: 'AUTH_READ_ERROR',
        message: 'Could not read local authentication secret.',
      });
    }

    // Connect to named pipe
    const socket = net.createConnection(PIPE_PATH);
    let responseData = '';
    let completed = false;

    socket.setTimeout(8000);

    socket.on('connect', () => {
      const payload = {
        secret,
        protocolVersion: request.protocolVersion || PROTOCOL_VERSION,
        requestId: request.requestId,
        operation: request.operation,
        payload: request.payload,
      };
      socket.write(JSON.stringify(payload) + '\n');
    });

    socket.on('data', (chunk) => {
      responseData += chunk.toString('utf8');
      if (responseData.includes('\n')) {
        completed = true;
        socket.end();
        try {
          const resObj = JSON.parse(responseData.trim());
          resolve(resObj);
        } catch {
          resolve({
            protocolVersion: PROTOCOL_VERSION,
            requestId: request.requestId || 'unknown',
            ok: false,
            code: 'INVALID_IPC_RESPONSE',
            message: 'BARQ Desktop returned invalid response.',
          });
        }
      }
    });

    socket.on('timeout', () => {
      if (completed) return;
      completed = true;
      socket.destroy();
      log('warn', 'IPC request timed out');
      resolve({
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId || 'unknown',
        ok: false,
        code: 'REQUEST_TIMEOUT',
        message: 'Request to BARQ Downloader timed out.',
      });
    });

    socket.on('error', (err) => {
      if (completed) return;
      completed = true;
      log('warn', 'IPC connection error', { code: err.code, message: err.message });
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        resolve({
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId || 'unknown',
          ok: false,
          status: 'unavailable',
          code: 'BARQ_NOT_RUNNING',
          message: 'BARQ Downloader is not running. Please launch BARQ Downloader.',
        });
      } else {
        resolve({
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId || 'unknown',
          ok: false,
          code: 'IPC_ERROR',
          message: `Local connection error: ${err.message}`,
        });
      }
    });
  });
}

// -----------------------------------------------------------------------------
// Main Stdin Processing Loop
// -----------------------------------------------------------------------------
let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', async (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length >= 4) {
    const msgLen = inputBuffer.readUInt32LE(0);

    if (msgLen > MAX_MESSAGE_SIZE) {
      log('error', `Oversized message received: ${msgLen} bytes (limit: ${MAX_MESSAGE_SIZE})`);
      sendNativeMessage({
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'unknown',
        ok: false,
        code: 'OVERSIZED_MESSAGE',
        message: 'Message exceeds maximum allowable size of 1 MiB.',
      });
      process.exit(1);
    }

    // Wait until full message has arrived
    if (inputBuffer.length < 4 + msgLen) {
      break;
    }

    const messageBytes = inputBuffer.subarray(4, 4 + msgLen);
    inputBuffer = inputBuffer.subarray(4 + msgLen);

    let parsed;
    try {
      parsed = JSON.parse(messageBytes.toString('utf8'));
    } catch {
      log('error', 'Malformed JSON received from browser');
      sendNativeMessage({
        protocolVersion: PROTOCOL_VERSION,
        requestId: 'unknown',
        ok: false,
        code: 'MALFORMED_JSON',
        message: 'Failed to parse JSON payload.',
      });
      continue;
    }

    log('info', 'Processing Native Message', { operation: parsed.operation, requestId: parsed.requestId });

    // Validate operation shape
    if (!parsed || typeof parsed !== 'object' || !parsed.operation) {
      sendNativeMessage({
        protocolVersion: PROTOCOL_VERSION,
        requestId: parsed?.requestId || 'unknown',
        ok: false,
        code: 'INVALID_REQUEST',
        message: 'Request must contain a valid operation.',
      });
      continue;
    }

    // Forward to BARQ application
    const response = await sendToBarqApp(parsed);
    sendNativeMessage(response);
  }
});

process.stdin.on('end', () => {
  log('info', 'Standard input closed; terminating Native Messaging Host.');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('error', 'Uncaught exception in Native Messaging Host:', { message: err.message, stack: err.stack });
});
