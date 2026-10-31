'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const brand = require('../shared/brand');

/**
 * Returns true if `dir` exists (or can be created) and a probe file can be
 * written and removed inside it. Never throws.
 */
function isWritableDir(dir, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.barq-write-probe-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fsImpl.writeFileSync(probe, 'ok');
    fsImpl.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves where BARQ stores its database, logs, temp files and Electron profile.
 *
 * Priority:
 *  1. BARQ_DATA_DIR environment override (absolute path only; used by tests/smoke checks).
 *  2. Packaged build: `<exe dir>/portable-data` when writable  → mode "portable".
 *  3. Development (unpackaged): `<project root>/dev-data`        → mode "development".
 *  4. Per-user fallback: `<fallbackBase>/BARQ Downloader`        → mode "per-user".
 *
 * @param {object} o
 * @param {boolean} o.isPackaged
 * @param {string} o.execPath      process.execPath
 * @param {string} o.appRoot       project/app root directory
 * @param {string} o.fallbackBase  e.g. %LOCALAPPDATA% (app.getPath('appData') fallback)
 * @param {Record<string,string|undefined>} [o.env]
 * @param {(dir:string)=>boolean} [o.isWritable]
 * @returns {{ mode: 'override'|'portable'|'development'|'per-user', dataDir: string, reason: string }}
 */
function resolveDataDir({ isPackaged, execPath, appRoot, fallbackBase, env = process.env, isWritable = isWritableDir }) {
  const override = env.BARQ_DATA_DIR;
  if (override && path.isAbsolute(override) && isWritable(override)) {
    return { mode: 'override', dataDir: path.resolve(override), reason: 'BARQ_DATA_DIR environment override' };
  }

  if (isPackaged) {
    const portableDir = path.join(path.dirname(execPath), brand.PORTABLE_FOLDER_NAME);
    if (isWritable(portableDir)) {
      return { mode: 'portable', dataDir: portableDir, reason: 'portable-data folder beside executable is writable' };
    }
  } else {
    const devDir = path.join(appRoot, 'dev-data');
    if (isWritable(devDir)) {
      return { mode: 'development', dataDir: devDir, reason: 'running from source; using project dev-data folder' };
    }
  }

  const userDir = path.join(fallbackBase, brand.DATA_FOLDER_NAME);
  return {
    mode: 'per-user',
    dataDir: userDir,
    reason: isPackaged
      ? 'portable-data folder is not writable (e.g. read-only or Program Files); using per-user fallback'
      : 'dev-data folder not writable; using per-user fallback',
  };
}

/**
 * Builds the full set of sub-paths beneath a data directory and creates them.
 */
function buildDataLayout(dataDir, fsImpl = fs) {
  const layout = {
    dataDir,
    dbPath: path.join(dataDir, brand.DATABASE_FILE),
    logsDir: path.join(dataDir, 'logs'),
    tempDir: path.join(dataDir, 'temp'),
    backupsDir: path.join(dataDir, 'backups'),
    electronDir: path.join(dataDir, 'electron-profile'),
  };
  for (const key of ['dataDir', 'logsDir', 'tempDir', 'backupsDir', 'electronDir']) {
    fsImpl.mkdirSync(layout[key], { recursive: true });
  }
  return layout;
}

module.exports = { resolveDataDir, buildDataLayout, isWritableDir };
