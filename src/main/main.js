'use strict';

/**
 * BARQ Downloader — Electron main process entry.
 * برق ڈاؤنلوڈر — Speed at Every Click.
 */
const path = require('node:path');
const { app, session, dialog, Menu } = require('electron');
const brand = require('../shared/brand');
const { resolveDataDir, buildDataLayout } = require('./paths');
const { createLogger } = require('./logger');
const { registerPrivilegedScheme, registerAppProtocol } = require('./app-protocol');
const { createSplashWindow, createMainWindow } = require('./windows');
const { APP_ORIGIN } = require('./security');
const { BarqDatabase } = require('./db/database');
const { SettingsRepo } = require('./db/settings-repo');
const { DownloadsRepo, EventsRepo } = require('./db/downloads-repo');
const { buildSchema } = require('./settings-schema');
const { registerIpc, applyTheme } = require('./ipc');

const APP_ROOT = path.join(__dirname, '..', '..');
const SMOKE = process.env.BARQ_SMOKE === '1';

// ---------------------------------------------------------------------------
// 1. Data location (must happen before 'ready' and before the instance lock,
//    because Electron keys its profile + lock on the userData path).
// ---------------------------------------------------------------------------
app.setName(brand.PRODUCT_NAME);
if (process.platform === 'win32') app.setAppUserModelId(brand.APP_ID);

const dataInfo = resolveDataDir({
  isPackaged: app.isPackaged,
  execPath: process.execPath,
  appRoot: APP_ROOT,
  fallbackBase: process.env.LOCALAPPDATA || app.getPath('appData'),
});
const layout = buildDataLayout(dataInfo.dataDir);
app.setPath('userData', layout.electronDir);
app.setPath('sessionData', layout.electronDir);
app.setAppLogsPath(layout.logsDir);

const logger = createLogger(layout.logsDir, { echo: !app.isPackaged || SMOKE });
logger.info('BARQ starting', { version: app.getVersion(), dataMode: dataInfo.mode, dataDir: layout.dataDir });

// ---------------------------------------------------------------------------
// 2. Single instance (one process owns the database).
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  logger.info('Another BARQ instance is running; exiting');
  app.quit();
} else {
  start();
}

function start() {
  registerPrivilegedScheme();
  app.enableSandbox();
  Menu.setApplicationMenu(null);

  /** @type {Electron.BrowserWindow | null} */
  let mainWindow = null;
  let splash = null;
  let database = null;
  const trustedIds = new Set();
  const engineState = { overallSpeedBps: 0, activeTransfers: 0 }; // populated by the engine in Milestone 2

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Global web-contents hardening.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('console-message', (_ev, level, message, line, sourceId) => {
      logger.info(`Renderer: ${message}`, { level, line, sourceId });
    });
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (ev, url) => {
      if (!String(url).startsWith(`${APP_ORIGIN}/`)) {
        ev.preventDefault();
        logger.warn('Blocked navigation', { url });
      }
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
  });

  app.whenReady().then(() => {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    ses.setPermissionCheckHandler(() => false);
    if (typeof ses.setDevicePermissionHandler === 'function') ses.setDevicePermissionHandler(() => false);
    // The renderer never needs network access; downloads run in the main process.
    ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_d, cb) => cb({ cancel: true }));
    registerAppProtocol(ses, logger);

    // Database ---------------------------------------------------------------
    try {
      database = new BarqDatabase(layout.dbPath, { logger }).open();
    } catch (err) {
      logger.error('Database failed to open', err);
      dialog.showErrorBox(`${brand.PRODUCT_NAME} — database error`, err.message);
      app.exit(1);
      return;
    }
    const schema = buildSchema({ defaultDownloadDir: app.getPath('downloads') });
    const settings = new SettingsRepo(database, schema);
    const downloads = new DownloadsRepo(database);
    const events = new EventsRepo(database);
    if (database.recoveredFrom) {
      events.add({ level: 'warn', type: 'db-recovered', message: 'A damaged database was quarantined and a fresh one was created.' });
    }
    events.add({ type: 'app-start', message: `${brand.PRODUCT_NAME} ${app.getVersion()} started (${dataInfo.mode} data)` });
    events.prune();

    applyTheme(settings.get('theme'));

    registerIpc({
      database, settings, downloads, events, layout, dataInfo, logger,
      getMainWindow: () => mainWindow, trustedIds, engineState,
    });

    // Windows ------------------------------------------------------------------
    if (!SMOKE) splash = createSplashWindow();
    mainWindow = createMainWindow();
    trustedIds.add(mainWindow.webContents.id);

    mainWindow.webContents.on('render-process-gone', (_e, details) => logger.error('Renderer gone', details));

    mainWindow.once('ready-to-show', () => {
      if (splash && !splash.isDestroyed()) splash.close();
      splash = null;
      if (!SMOKE) mainWindow.show();
    });
    mainWindow.on('closed', () => {
      trustedIds.clear();
      mainWindow = null;
    });

    if (SMOKE) runSmoke(mainWindow);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    if (database) {
      database.close();
      database = null;
      logger.info('Database closed');
    }
  });
}

/**
 * Smoke-check mode (BARQ_SMOKE=1): loads the real UI hidden, inspects the
 * renderer security surface and rendered content, prints a JSON report and exits.
 */
function runSmoke(win) {
  const timeout = setTimeout(() => {
    console.log('BARQ_SMOKE_RESULT ' + JSON.stringify({ ok: false, error: 'timeout' }));
    app.exit(2);
  }, 30000);
  win.webContents.once('did-finish-load', async () => {
    try {
      const report = await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        for (let i = 0; i < 100 && document.body.dataset.ready !== '1'; i++) await wait(100);
        const nav = [...document.querySelectorAll('[data-nav]')].map(b => b.dataset.nav);
        const results = { ready: document.body.dataset.ready === '1', title: document.title, nav };
        results.typeofRequire = typeof window.require;
        results.typeofProcess = typeof window.process;
        results.typeofModule = typeof window.module;
        results.barqApi = Object.keys(window.barq || {});
        results.barqFrozen = Object.isFrozen(window.barq);
        results.cspMeta = !!document.querySelector('meta[http-equiv="Content-Security-Policy"]');
        // Inline script must be blocked by CSP.
        window.__inlineRan = false;
        const s = document.createElement('script'); s.textContent = 'window.__inlineRan = true'; document.head.appendChild(s);
        await wait(50);
        results.inlineScriptBlocked = window.__inlineRan === false;
        // Network from renderer must fail.
        try { await fetch('https://example.com/'); results.fetchBlocked = false; } catch { results.fetchBlocked = true; }
        // Navigate through every view and confirm it renders.
        results.views = {};
        for (const v of nav) {
          document.querySelector('[data-nav="' + v + '"]').click();
          await wait(150);
          const main = document.getElementById('view');
          results.views[v] = { heading: (main.querySelector('h1') || {}).textContent || null, rows: main.querySelectorAll('tbody tr[data-id]').length };
        }
        const info = await window.barq.app.getInfo();
        results.dataMode = info.dataMode;
        results.dataDir = info.dataDir;
        const settings = await window.barq.settings.get();
        results.settingsKeys = Object.keys(settings);
        const bad = await window.barq.settings.update({ downloadDir: 'C:\\\\Windows' }).then(() => 'accepted', e => e.message);
        results.mainOnlySettingRejected = bad !== 'accepted';
        const unknown = await window.barq.settings.update({ evil: 1 }).then(() => 'accepted', e => e.message);
        results.unknownSettingRejected = unknown !== 'accepted';
        const urlBad = await window.barq.downloads.validateUrl('file:///C:/Windows/win.ini');
        results.fileUrlRejected = urlBad.ok === false;
        const db = await window.barq.database.info();
        results.schemaVersion = db.schemaVersion;
        return results;
      })()`, true);
      clearTimeout(timeout);
      console.log('BARQ_SMOKE_RESULT ' + JSON.stringify({ ok: true, report }));
      app.exit(0);
    } catch (err) {
      clearTimeout(timeout);
      console.log('BARQ_SMOKE_RESULT ' + JSON.stringify({ ok: false, error: String(err && err.message) }));
      app.exit(1);
    }
  });
}
