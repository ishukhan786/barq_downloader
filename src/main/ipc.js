'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ipcMain, dialog, shell, clipboard, app, nativeTheme, BrowserWindow } = require('electron');
const brand = require('../shared/brand');
const { CATEGORIES } = require('../shared/categories');
const { isTrustedSender, validateId, validateDownloadUrl, isPathInside } = require('./security');
const { VIEW_FILTERS } = require('./db/downloads-repo');
const { BarqDatabase } = require('./db/database');

/** Fixed allowlist: the renderer can only ask to open these by key, never an arbitrary URL. */
const EXTERNAL_LINKS = Object.freeze({
  ytdlp: 'https://github.com/yt-dlp/yt-dlp',
  ffmpeg: 'https://ffmpeg.org/',
  electron: 'https://www.electronjs.org/',
});

/** Every channel the renderer may invoke. Anything else is unhandled by design. */
const CHANNELS = Object.freeze([
  'app:getInfo',
  'stats:get',
  'downloads:list',
  'downloads:add',
  'downloads:probe',
  'downloads:pause',
  'downloads:resume',
  'downloads:cancel',
  'downloads:retry',
  'downloads:remove',
  'downloads:showInFolder',
  'downloads:openFile',
  'downloads:details',
  'downloads:chooseDestination',
  'downloads:copyUrl',
  'queue:get',
  'activity:recent',
  'settings:get',
  'settings:update',
  'settings:chooseDownloadDir',
  'url:validate',
  'db:info',
  'db:backup',
  'db:restore',
  'temp:info',
  'temp:clear',
  'shell:openExternal',
  'shell:openDataFolder',
]);

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) {
        files += 1;
        try { bytes += fs.statSync(full).size; } catch { /* vanished */ }
      }
    }
  };
  walk(dir, 0);
  return { files, bytes };
}

function applyTheme(theme) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
}

function applyAutoStart(enabled, logger) {
  if (!app.isPackaged) return { applied: false, note: 'Auto-start is only registered for packaged builds.' };
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath });
    return { applied: true };
  } catch (err) {
    logger.warn('Failed to apply auto-start', err);
    return { applied: false, note: 'Windows rejected the auto-start change.' };
  }
}

/**
 * @param {object} ctx
 * @param {import('./db/database').BarqDatabase} ctx.database
 * @param {import('./db/settings-repo').SettingsRepo} ctx.settings
 * @param {import('./db/downloads-repo').DownloadsRepo} ctx.downloads
 * @param {import('./db/downloads-repo').EventsRepo} ctx.events
 * @param {object} ctx.layout
 * @param {object} ctx.dataInfo
 * @param {object} ctx.logger
 * @param {() => Electron.BrowserWindow | null} ctx.getMainWindow
 * @param {Set<number>} ctx.trustedIds  webContents ids allowed to call IPC
 * @param {{ overallSpeedBps: number, activeTransfers: number }} ctx.engineState
 */
function registerIpc(ctx) {
  const { database, settings, downloads, events, layout, dataInfo, logger, getMainWindow, trustedIds, engineState, downloadManager } = ctx;

  const broadcast = (channel, payload) => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  };

  function handle(channel, fn) {
    if (!CHANNELS.includes(channel)) throw new Error(`Channel ${channel} not in allowlist`);
    ipcMain.handle(channel, async (event, ...args) => {
      if (!isTrustedSender(event, trustedIds)) {
        logger.warn('Rejected IPC from untrusted sender', { channel, url: event.senderFrame && event.senderFrame.url });
        return { ok: false, error: 'Forbidden' };
      }
      if (args.length > 1) return { ok: false, error: 'Too many arguments' };
      try {
        const data = await fn(args[0], event);
        return { ok: true, data };
      } catch (err) {
        logger.error(`IPC ${channel} failed`, err);
        return { ok: false, error: err && err.expose ? err.message : 'The operation failed. See logs for details.' };
      }
    });
  }

  const userError = (message) => Object.assign(new Error(message), { expose: true });
  const parentWin = () => getMainWindow() || BrowserWindow.getFocusedWindow() || undefined;

  handle('app:getInfo', () => ({
    productName: brand.PRODUCT_NAME,
    productNameUrdu: brand.PRODUCT_NAME_URDU,
    brand: brand.BRAND,
    brandUrdu: brand.BRAND_URDU,
    tagline: brand.TAGLINE,
    appId: brand.APP_ID,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    sqlite: process.versions.sqlite || null,
    platform: `${process.platform}-${process.arch}`,
    packaged: app.isPackaged,
    dataMode: dataInfo.mode,
    dataReason: dataInfo.reason,
    dataDir: layout.dataDir,
    categories: CATEGORIES,
    engineAvailable: true,
  }));

  handle('stats:get', () => {
    const globalTel = downloadManager ? downloadManager.getGlobalTelemetry() : engineState;
    return {
      ...downloads.stats(),
      overallSpeedBps: globalTel.overallSpeedBps,
      activeTransfers: globalTel.activeTransfers,
    };
  });

  handle('downloads:probe', async (url) => {
    const val = validateDownloadUrl(url);
    if (!val.ok) throw userError(val.error);
    if (!downloadManager) throw userError('Download engine not ready.');
    return downloadManager.probe(val.url);
  });

  handle('downloads:add', async (params) => {
    if (!params || typeof params !== 'object') throw userError('Invalid parameters.');
    const val = validateDownloadUrl(params.url);
    if (!val.ok) throw userError(val.error);
    if (!downloadManager) throw userError('Download engine not ready.');

    const filename = typeof params.filename === 'string' ? params.filename.trim() : null;
    const dest = typeof params.destination === 'string' ? params.destination.trim() : null;
    const startNow = params.startNow !== false;

    const record = await downloadManager.add({
      sourceUrl: val.url,
      filename,
      destinationPath: dest,
      startNow,
    });
    return record;
  });

  handle('downloads:pause', async (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    if (!downloadManager) throw userError('Download engine not ready.');
    return downloadManager.pause(vid);
  });

  handle('downloads:resume', async (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    if (!downloadManager) throw userError('Download engine not ready.');
    return downloadManager.resume(vid);
  });

  handle('downloads:cancel', async (args) => {
    const id = typeof args === 'object' && args !== null ? args.id : args;
    const deletePartial = typeof args === 'object' && args !== null ? !!args.deletePartial : false;
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    if (!downloadManager) throw userError('Download engine not ready.');
    return downloadManager.cancel(vid, deletePartial);
  });

  handle('downloads:retry', async (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    if (!downloadManager) throw userError('Download engine not ready.');
    return downloadManager.retry(vid);
  });

  handle('downloads:openFile', (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    const rec = downloads.getById(vid);
    if (!rec) throw userError('Download not found.');
    if (rec.status !== 'completed') throw userError('Only completed files can be opened.');
    const full = path.join(rec.destination_path, rec.filename);
    if (!fs.existsSync(full)) throw userError('The downloaded file could not be found on disk.');
    shell.openPath(full);
    return true;
  });

  handle('downloads:details', (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    const rec = downloads.getById(vid);
    if (!rec) throw userError('Download not found.');
    const tel = downloadManager ? downloadManager.getTelemetry(vid) : null;
    return { ...rec, telemetry: tel };
  });

  handle('downloads:chooseDestination', async () => {
    const current = settings.get('downloadDir');
    const r = await dialog.showOpenDialog(parentWin(), {
      title: 'Choose destination folder',
      defaultPath: current || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true, path: current };
    const dir = r.filePaths[0];
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { throw userError('BARQ cannot write to that folder. Choose another.'); }
    return { canceled: false, path: dir };
  });

  handle('downloads:list', (q) => {
    const query = q && typeof q === 'object' ? q : {};
    const view = typeof query.view === 'string' && Object.hasOwn(VIEW_FILTERS, query.view) ? query.view : null;
    if (!view) throw userError('Unknown view.');
    const search = typeof query.search === 'string' ? query.search.slice(0, 200) : '';
    return downloads.list({ view, search });
  });

  handle('downloads:remove', async (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    const rec = downloads.getById(vid);
    if (!rec) throw userError('Download not found.');
    if (rec.status === 'downloading') throw userError('Pause or cancel the download before removing it.');
    if (downloadManager) {
      await downloadManager.remove(vid);
    } else {
      downloads.remove(vid);
    }
    events.add({ type: 'removed', message: `Removed "${rec.filename}" from the list` });
    return true;
  });

  handle('downloads:showInFolder', (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    const rec = downloads.getById(vid);
    if (!rec) throw userError('Download not found.');
    const full = path.join(rec.destination_path, rec.filename);
    if (fs.existsSync(full)) { shell.showItemInFolder(full); return true; }
    if (fs.existsSync(rec.destination_path)) { shell.openPath(rec.destination_path); return true; }
    throw userError('The destination folder no longer exists.');
  });

  handle('downloads:copyUrl', (id) => {
    const vid = validateId(id);
    if (!vid) throw userError('Invalid download id.');
    const rec = downloads.getById(vid);
    if (!rec) throw userError('Download not found.');
    clipboard.writeText(rec.source_url);
    return true;
  });

  handle('queue:get', () => downloads.queue(10));
  handle('activity:recent', () => events.recent(20));

  handle('settings:get', () => settings.getAll());

  handle('settings:update', (patch) => {
    const res = settings.update(patch);
    if (!res.ok) throw userError(res.error);
    const notes = [];
    if (res.changed.includes('theme')) applyTheme(res.settings.theme);
    if (res.changed.includes('autoStart')) {
      const r = applyAutoStart(res.settings.autoStart, logger);
      if (r.note) notes.push(r.note);
    }
    broadcast('settings:changed', res.settings);
    return { settings: res.settings, notes };
  });

  handle('settings:chooseDownloadDir', async () => {
    const current = settings.get('downloadDir');
    const r = await dialog.showOpenDialog(parentWin(), {
      title: 'Choose default download folder',
      defaultPath: current || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true, settings: settings.getAll() };
    const dir = r.filePaths[0];
    // Writability check before accepting.
    try { fs.accessSync(dir, fs.constants.W_OK); } catch { throw userError('BARQ cannot write to that folder. Choose another.'); }
    const res = settings.update({ downloadDir: dir }, { trusted: true });
    if (!res.ok) throw userError(res.error);
    events.add({ type: 'settings', message: 'Default download folder changed' });
    broadcast('settings:changed', res.settings);
    return { canceled: false, settings: res.settings };
  });

  handle('url:validate', (url) => validateDownloadUrl(url));

  handle('db:info', () => {
    let bytes = 0;
    try { bytes = fs.statSync(layout.dbPath).size; } catch { /* new */ }
    return {
      path: layout.dbPath,
      bytes,
      schemaVersion: database.userVersion,
      latestVersion: database.latestVersion,
      migrations: database.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all(),
      backupsDir: layout.backupsDir,
      recoveredFrom: database.recoveredFrom,
    };
  });

  handle('db:backup', async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const r = await dialog.showSaveDialog(parentWin(), {
      title: 'Back up BARQ database',
      defaultPath: path.join(layout.backupsDir, `barq-backup-${stamp}.db`),
      filters: [{ name: 'BARQ database backup', extensions: ['db'] }],
      properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    // Never overwrite silently: if the user confirmed overwrite in the OS dialog, write
    // to a temp name first and swap only after a successful snapshot.
    const dest = r.filePath;
    const tmp = `${dest}.barq-tmp-${process.pid}`;
    fs.rmSync(tmp, { force: true });
    const res = database.backupTo(tmp);
    fs.renameSync(tmp, dest);
    events.add({ type: 'backup', message: `Database backed up (${res.bytes} bytes)` });
    return { canceled: false, path: dest, bytes: res.bytes };
  });

  handle('db:restore', async () => {
    const active = downloads.stats().active;
    if (active > 0) throw userError('Stop all active downloads before restoring a backup.');
    const r = await dialog.showOpenDialog(parentWin(), {
      title: 'Restore BARQ database from backup',
      defaultPath: layout.backupsDir,
      filters: [{ name: 'BARQ database backup', extensions: ['db'] }],
      properties: ['openFile', 'dontAddToRecent'],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const src = r.filePaths[0];
    if (path.resolve(src).toLowerCase() === path.resolve(layout.dbPath).toLowerCase()) {
      throw userError('That is the live database, not a backup.');
    }
    const check = BarqDatabase.inspectBackup(src, database.latestVersion);
    if (!check.ok) throw userError(check.error);
    const res = database.restoreFrom(src, layout.backupsDir);
    applyTheme(settings.get('theme'));
    events.add({ type: 'restore', message: 'Database restored from backup' });
    broadcast('settings:changed', settings.getAll());
    return { canceled: false, safetyBackup: res.safetyBackup, schemaVersion: res.version };
  });

  handle('temp:info', () => ({ path: layout.tempDir, ...dirStats(layout.tempDir) }));

  handle('temp:clear', () => {
    if (downloads.stats().active > 0) throw userError('Temporary files are in use by active downloads.');
    // Partial data of paused/queued downloads must be preserved for resume.
    const resumable = downloads.stats().paused + downloads.stats().queued;
    if (resumable > 0) throw userError('Paused or queued downloads still need their temporary files.');
    let removed = 0;
    for (const name of fs.readdirSync(layout.tempDir)) {
      const full = path.join(layout.tempDir, name);
      if (!isPathInside(layout.tempDir, full)) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed += 1;
    }
    events.add({ type: 'temp', message: `Cleared ${removed} temporary item(s)` });
    return { removed, ...dirStats(layout.tempDir) };
  });

  handle('shell:openExternal', async (key) => {
    if (typeof key !== 'string' || !Object.hasOwn(EXTERNAL_LINKS, key)) throw userError('Unknown link.');
    await shell.openExternal(EXTERNAL_LINKS[key]);
    return true;
  });

  handle('shell:openDataFolder', async () => {
    const err = await shell.openPath(layout.dataDir);
    if (err) throw userError(err);
    return true;
  });

  return { applyTheme, applyAutoStart };
}

module.exports = { registerIpc, CHANNELS, EXTERNAL_LINKS, applyTheme };
