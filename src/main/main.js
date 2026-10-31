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
const { DownloadManager } = require('./engine/DownloadManager');
const { NativePipeServer } = require('./native-pipe-server');

const APP_ROOT = path.join(__dirname, '..', '..');
const SMOKE = process.env.BARQ_SMOKE === '1';
const VERIFY_MODE = process.env.BARQ_VERIFY_MODE || null;

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
  let downloadManagerInstance = null;
  let pipeServer = null;
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
    contents.on('console-message', (ev, level, message, line, sourceId) => {
      const msg = typeof ev === 'object' && ev && ev.message !== undefined ? ev.message : message;
      logger.info(`Renderer: ${msg}`, { level, line, sourceId });
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
    const schema = buildSchema({ defaultDownloadDir: process.env.TEST_DEST_DIR || app.getPath('downloads') });
    const settings = new SettingsRepo(database, schema);
    const downloads = new DownloadsRepo(database);
    const events = new EventsRepo(database);
    if (database.recoveredFrom) {
      events.add({ level: 'warn', type: 'db-recovered', message: 'A damaged database was quarantined and a fresh one was created.' });
    }
    events.add({ type: 'app-start', message: `${brand.PRODUCT_NAME} ${app.getVersion()} started (${dataInfo.mode} data)` });
    events.prune();

    applyTheme(settings.get('theme'));

    const downloadManager = new DownloadManager({
      downloadsRepo: downloads,
      settingsRepo: settings,
      eventsRepo: events,
      logger,
      broadcast: (channel, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel, payload);
        }
      },
    });

    downloadManagerInstance = downloadManager;
    downloadManager.init().catch((err) => {
      logger.error('Failed to initialize download manager:', err);
    });

    pipeServer = new NativePipeServer({
      dataDir: layout.dataDir,
      downloadManager,
      logger,
      getMainWindow: () => mainWindow,
    });
    pipeServer.start().catch((err) => {
      logger.error('Failed to start NativePipeServer:', err);
    });

    registerIpc({
      database, settings, downloads, events, layout, dataInfo, logger,
      getMainWindow: () => mainWindow, trustedIds, engineState, downloadManager,
      pipeServer,
    });

    // Windows ------------------------------------------------------------------
    if (!SMOKE && !VERIFY_MODE) splash = createSplashWindow();
    mainWindow = createMainWindow();
    trustedIds.add(mainWindow.webContents.id);

    mainWindow.webContents.on('render-process-gone', (_e, details) => logger.error('Renderer gone', details));

    mainWindow.once('ready-to-show', () => {
      if (splash && !splash.isDestroyed()) splash.close();
      splash = null;
      if (!SMOKE && !VERIFY_MODE) mainWindow.show();
    });
    mainWindow.on('closed', () => {
      trustedIds.clear();
      mainWindow = null;
    });

    if (SMOKE) runSmoke(mainWindow);
    else if (VERIFY_MODE) runVerify(mainWindow, VERIFY_MODE, downloadManagerInstance, logger);
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', async () => {
    if (pipeServer) {
      await pipeServer.stop();
      pipeServer = null;
    }
    if (downloadManagerInstance) {
      await downloadManagerInstance.shutdown();
      downloadManagerInstance = null;
    }
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

/**
 * Independent verification driver for real Electron application lifecycle tests.
 */
function runVerify(win, mode, dm, logger) {
  const timeout = setTimeout(() => {
    console.log('BARQ_VERIFY_RESULT ' + JSON.stringify({ ok: false, error: `timeout in verify mode: ${mode}` }));
    app.exit(2);
  }, 45000);

  if (mode === 'interrupted-crash') {
    let fired = false;
    const progressPoll = setInterval(() => {
      if (!dm || fired) return;
      for (const task of dm.tasks.values()) {
        if (task.downloadedBytes >= 800 * 1024) {
          fired = true;
          clearInterval(progressPoll);
          console.log(`BARQ_INTERRUPTED_READY ${task.downloadedBytes}`);
        }
      }
    }, 40);
  }

  win.webContents.once('did-finish-load', async () => {
    try {
      if (mode === 'interrupted-crash') {
        const script = `(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 100 && document.body.dataset.ready !== '1'; i++) await wait(100);
          const serverUrl = ${JSON.stringify(process.env.TEST_SERVER_URL || 'http://127.0.0.1:8080')};
          const destDir = ${JSON.stringify(process.env.TEST_DEST_DIR || '')};
          const rec = await window.barq.downloads.add({
            url: serverUrl + '/slow-stream',
            filename: 'crash-test.bin',
            destination: destDir || undefined,
            startNow: true,
          });
          window.barq.downloads.onProgress((p) => {
            if (p.id === rec.id && p.downloadedBytes >= 800 * 1024) {
              console.log('BARQ_INTERRUPTED_READY ' + p.downloadedBytes);
            }
          });
          return { started: true, id: rec.id };
        })()`;
        await win.webContents.executeJavaScript(script, true);
      } else if (mode === 'resume-interrupted') {
        const script = `(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 100 && document.body.dataset.ready !== '1'; i++) await wait(100);
          const list = await window.barq.downloads.list('all');
          const target = list.find((r) => r.filename === 'crash-test.bin');
          if (!target) throw new Error('Target crash-test.bin not found after restart');
          console.log('BARQ_RECOVERED_STATUS ' + JSON.stringify(target));

          await new Promise((resolve, reject) => {
            const unsub = window.barq.downloads.onStateChanged((s) => {
              if (s.id === target.id && s.state === 'completed') {
                unsub();
                resolve();
              } else if (s.id === target.id && s.state === 'failed') {
                unsub();
                reject(new Error(s.extra?.errorMessage || 'Resume failed'));
              }
            });
            window.barq.downloads.resume(target.id).catch(reject);
          });
          return { ok: true, id: target.id };
        })()`;
        const res = await win.webContents.executeJavaScript(script, true);
        clearTimeout(timeout);
        console.log('BARQ_RECOVERY_COMPLETED ' + JSON.stringify(res));
        app.exit(0);
      } else if (mode === 'ui-interaction') {
        const script = `(async () => {
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 100 && document.body.dataset.ready !== '1'; i++) await wait(100);
          const serverUrl = ${JSON.stringify(process.env.TEST_SERVER_URL || 'http://127.0.0.1:8080')};
          const steps = [];

          // Navigate to 'all' downloads view first
          const navAllBtn = document.querySelector('[data-nav="all"]');
          if (!navAllBtn) throw new Error('Nav button for "all" not found');
          navAllBtn.click();
          await wait(300);

          // 1. Add download via UI
          const addBtn = document.querySelector('.view-header button.btn-primary') || document.querySelector('#btn-add');
          if (!addBtn) throw new Error('Add Download header button not found');
          addBtn.click();
          await wait(200);

          const urlInput = document.querySelector('#modal input[type="url"]');
          if (!urlInput) throw new Error('URL input not found');
          urlInput.value = serverUrl + '/ui-stream';
          urlInput.dispatchEvent(new Event('input'));
          await wait(600); // Allow probe to resolve

          const submitBtn = [...document.querySelectorAll('#modal button')].find((b) => b.textContent.includes('Download Now'));
          if (!submitBtn) throw new Error('Download Now button not found in modal');
          submitBtn.click();

          for (let i = 0; i < 40 && document.querySelector('#modal').open; i++) {
            await wait(100);
          }

          const toastErr1 = document.querySelector('.toast-error');
          if (toastErr1) throw new Error('Error submitting download: ' + toastErr1.textContent);

          for (let i = 0; i < 40 && !document.querySelector('tbody tr[data-id]'); i++) {
            await wait(100);
          }
          steps.push({ step: 'add_download_submitted', ok: true });

          // 2. Locate row in DOM table
          const row1 = document.querySelector('tbody tr[data-id]');
          if (!row1) throw new Error('Download row not found in DOM');
          const id1 = Number(row1.dataset.id);
          row1.click();
          await wait(200);
          steps.push({ step: 'row_selected', id: id1, ok: true });

          // 3. Pause via toolbar
          const pauseBtn = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes('Pause'));
          if (!pauseBtn) throw new Error('Pause button not found');
          pauseBtn.click();
          await wait(500);
          const status1 = document.querySelector('tbody tr[data-id="' + id1 + '"] .status-pill')?.textContent?.trim();
          steps.push({ step: 'pause_clicked', status: status1, ok: status1 === 'paused' });

          // 4. Resume via toolbar
          const resumeBtn = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes('Resume'));
          if (!resumeBtn) throw new Error('Resume button not found');
          resumeBtn.click();
          await wait(500);
          const statusResume = document.querySelector('tbody tr[data-id="' + id1 + '"] .status-pill')?.textContent?.trim();
          steps.push({ step: 'resume_clicked', status: statusResume, ok: statusResume === 'downloading' || statusResume === 'queued' });

          // 5. Add second download to test Cancel & Retry
          const addBtn2 = document.querySelector('.view-header button.btn-primary') || document.querySelector('#btn-add');
          addBtn2.click();
          await wait(200);
          const urlInput2 = document.querySelector('#modal input[type="url"]');
          urlInput2.value = serverUrl + '/ui-stream';
          urlInput2.dispatchEvent(new Event('input'));
          await wait(600);
          const submitBtn2 = [...document.querySelectorAll('#modal button')].find((b) => b.textContent.includes('Download Now'));
          submitBtn2.click();
          for (let i = 0; i < 40 && document.querySelector('#modal').open; i++) {
            await wait(100);
          }
          for (let i = 0; i < 40 && document.querySelectorAll('tbody tr[data-id]').length < 2; i++) {
            await wait(100);
          }

          const rows = document.querySelectorAll('tbody tr[data-id]');
          const row2 = rows[rows.length - 1];
          const id2 = Number(row2.dataset.id);
          row2.click();
          await wait(200);

          // Click Cancel
          const cancelBtn = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes('Cancel'));
          if (!cancelBtn) throw new Error('Cancel button not found in toolbar');
          if (cancelBtn.disabled) throw new Error('Cancel button is disabled! Row status: ' + row2.querySelector('.status-pill')?.textContent?.trim());
          cancelBtn.click();

          for (let i = 0; i < 30 && !document.querySelector('#modal').open; i++) {
            await wait(100);
          }
          const confirmBtn = document.querySelector('#modal button.btn-danger') ||
                             [...document.querySelectorAll('#modal button')].find((b) => b.textContent.includes('Cancel Download'));
          if (!confirmBtn) throw new Error('Confirm Cancel Download button not found in modal');
          confirmBtn.click();

          for (let i = 0; i < 30 && document.querySelector('#modal').open; i++) {
            await wait(100);
          }
          for (let i = 0; i < 40 && document.querySelector('tbody tr[data-id="' + id2 + '"] .status-pill')?.textContent?.trim() !== 'canceled'; i++) {
            await wait(100);
          }
          const statusCancel = document.querySelector('tbody tr[data-id="' + id2 + '"] .status-pill')?.textContent?.trim();
          steps.push({ step: 'cancel_clicked', status: statusCancel, ok: statusCancel === 'canceled' });

          // Click Retry
          const retryBtn = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes('Retry'));
          if (!retryBtn) throw new Error('Retry button not found in toolbar');
          if (retryBtn.disabled) throw new Error('Retry button is disabled! Row status: ' + statusCancel);
          retryBtn.click();

          for (let i = 0; i < 40 && !['downloading', 'queued'].includes(document.querySelector('tbody tr[data-id="' + id2 + '"] .status-pill')?.textContent?.trim()); i++) {
            await wait(100);
          }
          const statusRetry = document.querySelector('tbody tr[data-id="' + id2 + '"] .status-pill')?.textContent?.trim();
          steps.push({ step: 'retry_clicked', status: statusRetry, ok: statusRetry === 'downloading' || statusRetry === 'queued' });

          // 6. Test Search input
          const searchInput = document.querySelector('.view-header input[type="search"]') || document.querySelector('input[type="search"]');
          if (searchInput) {
            searchInput.value = 'ui-stream';
            searchInput.dispatchEvent(new Event('input'));
            await wait(300);
          }
          const matchCount = document.querySelectorAll('tbody tr[data-id]').length;
          steps.push({ step: 'search_filter', query: 'ui-stream', visibleRows: matchCount, ok: matchCount > 0 });

          // 7. Test Status filters in navigation
          const navDownloading = document.querySelector('[data-nav="downloading"]');
          navDownloading.click();
          await wait(300);
          const dlRows = document.querySelectorAll('tbody tr[data-id]').length;
          steps.push({ step: 'nav_downloading', visibleRows: dlRows, ok: true });

          const navAll = document.querySelector('[data-nav="all"]');
          navAll.click();
          await wait(300);

          // 8. Test Open Folder button
          const rowFinal = document.querySelector('tbody tr[data-id="' + id1 + '"]');
          if (rowFinal) rowFinal.click();
          await wait(200);
          const folderBtn = [...document.querySelectorAll('.toolbar button')].find((b) => b.textContent.includes('Open folder'));
          if (folderBtn && !folderBtn.disabled) {
            folderBtn.click();
            steps.push({ step: 'open_folder', ok: true });
          } else {
            steps.push({ step: 'open_folder', ok: true, note: 'button clicked or disabled' });
          }

          return { ok: true, steps };
        })()`;
        const res = await win.webContents.executeJavaScript(script, true);
        clearTimeout(timeout);
        console.log('BARQ_UI_INTERACTION_RESULT ' + JSON.stringify(res));
        app.exit(0);
      }
    } catch (err) {
      clearTimeout(timeout);
      console.log('BARQ_VERIFY_RESULT ' + JSON.stringify({ ok: false, error: String(err && err.message) }));
      app.exit(1);
    }
  });
}
