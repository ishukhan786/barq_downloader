// Settings view: general, engine, database, and system options
import { h, icon, clear } from '../dom.js';
import { formatBytes } from '../format.js';
import { confirmDialog, guard, toast } from '../ui.js';

export function renderSettings(root, ctx) {
  let settings = {};
  let dbInfo = {};
  let tempInfo = {};
  let browserInfo = {};
  let updateInfo = { state: 'idle' };
  let disposed = false;

  const container = h('div', { class: 'settings' });

  root.append(
    h('div', { class: 'view-header' },
      h('div', {},
        h('h1', { text: 'Settings' }),
        h('p', { class: 'view-sub', text: 'Configure BARQ preferences and storage.' }))),
    container,
  );

  async function updateSetting(patch) {
    const res = await guard(ctx.api.settings.update(patch));
    if (res) {
      settings = res.settings;
      if (res.notes && res.notes.length) {
        for (const n of res.notes) toast(n, 'info');
      } else {
        toast('Settings updated', 'ok');
      }
      render();
    }
  }

  function render() {
    clear(container);

    // Section 1: General & Appearance
    const themeRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'Theme' }),
        h('small', { text: 'Choose your visual preference.' })),
      h('div', { class: 'setting-control' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Theme selection' },
          ...['dark', 'light', 'system'].map((t) =>
            h('button', {
              type: 'button',
              'aria-pressed': settings.theme === t ? 'true' : 'false',
              text: t[0].toUpperCase() + t.slice(1),
              onclick: () => updateSetting({ theme: t }),
            })))));

    const notifRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-notifications', text: 'Desktop Notifications' }),
        h('small', { text: 'Show Windows notifications on download completion or failure.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-notifications',
            type: 'checkbox',
            checked: settings.notifications,
            onchange: (e) => updateSetting({ notifications: e.target.checked }),
          }),
          h('span'))));

    const autoStartRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-autostart', text: 'Launch on Windows Startup' }),
        h('small', { text: 'Start BARQ automatically when you sign in.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-autostart',
            type: 'checkbox',
            checked: settings.autoStart,
            onchange: (e) => updateSetting({ autoStart: e.target.checked }),
          }),
          h('span'))));

    const genCard = h('div', { class: 'card settings-section' },
      h('h2', { text: 'Appearance & General' }),
      h('p', { class: 'section-sub', text: 'Theme, system notifications, and startup.' }),
      themeRow,
      notifRow,
      autoStartRow);

    // Section 2: Downloads & Engine
    const downloadDirRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'Default Download Folder' }),
        h('div', { class: 'path-display', text: settings.downloadDir || 'Default user downloads folder' })),
      h('div', { class: 'setting-control' },
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          onclick: async () => {
            const res = await guard(ctx.api.settings.chooseDownloadDir());
            if (res && !res.canceled) {
              settings = res.settings;
              render();
            }
          },
        }, icon('folder'), 'Browse…')));

    const concurrentRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-max-concurrent', text: 'Maximum Concurrent Downloads' }),
        h('small', { text: 'Number of downloads allowed to run simultaneously (1–16).' })),
      h('div', { class: 'setting-control' },
        h('input', {
          id: 'set-max-concurrent',
          class: 'input',
          type: 'number',
          min: 1,
          max: 16,
          value: settings.maxConcurrentDownloads,
          onchange: (e) => updateSetting({ maxConcurrentDownloads: Number(e.target.value) }),
        })));

    const segmentsRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-max-segments', text: 'Parallel Connections Per Download' }),
        h('small', { text: 'Number of HTTP Range segments for supported downloads (1–16, default: 8).' })),
      h('div', { class: 'setting-control' },
        h('input', {
          id: 'set-max-segments',
          class: 'input',
          type: 'number',
          min: 1,
          max: 16,
          value: settings.connectionsPerFile || settings.maxSegments || 8,
          onchange: (e) => updateSetting({ connectionsPerFile: Number(e.target.value), maxSegments: Number(e.target.value) }),
        })));

    const autoSegRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-auto-seg', text: 'Automatic Multi-Segment Acceleration' }),
        h('small', { text: 'Automatically split eligible downloads into parallel connection streams.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-auto-seg',
            type: 'checkbox',
            checked: settings.autoSegmentation !== false,
            onchange: (e) => updateSetting({ autoSegmentation: e.target.checked }),
          }),
          h('span'))));

    const autoFallbackRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-auto-fallback', text: 'Automatic Single-Connection Fallback' }),
        h('small', { text: 'Gracefully fall back to single-connection if multi-segment download fails or server rejects ranges.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-auto-fallback',
            type: 'checkbox',
            checked: settings.autoFallback !== false,
            onchange: (e) => updateSetting({ autoFallback: e.target.checked }),
          }),
          h('span'))));

    const speedLimitRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-speed-limit', text: 'Global Speed Limit (KB/s)' }),
        h('small', { text: 'Set to 0 for unlimited speed.' })),
      h('div', { class: 'setting-control' },
        h('input', {
          id: 'set-speed-limit',
          class: 'input',
          type: 'number',
          min: 0,
          max: 10000000,
          value: settings.globalSpeedLimitKBps,
          onchange: (e) => updateSetting({ globalSpeedLimitKBps: Number(e.target.value) }),
        })));

    const deletePartialRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-delete-partial', text: 'Delete Incomplete Files on Cancel' }),
        h('small', { text: 'Automatically remove partially downloaded files when a download is canceled.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-delete-partial',
            type: 'checkbox',
            checked: settings.deletePartialOnCancel,
            onchange: (e) => updateSetting({ deletePartialOnCancel: e.target.checked }),
          }),
          h('span'))));

    const dlCard = h('div', { class: 'card settings-section' },
      h('h2', { text: 'Download Engine & Queue' }),
      h('p', { class: 'section-sub', text: 'Storage paths, parallel connections, and speed limits.' }),
      downloadDirRow,
      concurrentRow,
      segmentsRow,
      autoSegRow,
      autoFallbackRow,
      speedLimitRow,
      deletePartialRow);

    // Section 3: Browser Integration
    const bridgeRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-browser', text: 'Enable Browser Bridge' }),
        h('small', { text: 'Allows authenticated BARQ extensions to send downloads to this application.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-browser',
            type: 'checkbox',
            checked: settings.browserIntegration,
            onchange: (e) => updateSetting({ browserIntegration: e.target.checked }),
          }),
          h('span'))));

    const confirmBrowserRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('label', { for: 'set-confirm-browser', text: 'Confirm Downloads from Browser' }),
        h('small', { text: 'Show the Add Download dialog before starting transfers received from the browser.' })),
      h('div', { class: 'setting-control' },
        h('label', { class: 'switch' },
          h('input', {
            id: 'set-confirm-browser',
            type: 'checkbox',
            checked: settings.confirmBrowserDownloads,
            onchange: (e) => updateSetting({ confirmBrowserDownloads: e.target.checked }),
          }),
          h('span'))));

    const hostStatusRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'Native Messaging Host Status' }),
        h('div', { class: 'setting-badges' },
          h('span', { class: `badge ${browserInfo?.chromeRegistered ? 'badge-ok' : 'badge-warn'}`, text: browserInfo?.chromeRegistered ? '✓ Chrome Registered' : 'Chrome Not Registered' }),
          h('span', { class: `badge ${browserInfo?.edgeRegistered ? 'badge-ok' : 'badge-warn'}`, text: browserInfo?.edgeRegistered ? '✓ Edge Registered' : 'Edge Not Registered' }),
          h('span', { class: `badge ${browserInfo?.pipeRunning ? 'badge-ok' : 'badge-muted'}`, text: browserInfo?.pipeRunning ? '● Pipe Listening' : 'Pipe Inactive' }))),
      h('div', { class: 'setting-control' },
        h('button', {
          class: 'btn btn-sm btn-primary',
          type: 'button',
          onclick: async () => {
            const res = await guard(ctx.api.browser.register(), 'Native host registered for Chrome & Edge');
            if (res?.ok) refresh();
          },
        }, icon('check'), 'Register Host')));

    const browserCard = h('div', { class: 'card settings-section' },
      h('h2', { text: 'Browser Extensions' }),
      h('p', { class: 'section-sub', text: 'Integration with Google Chrome and Microsoft Edge (Milestone 4).' }),
      bridgeRow,
      confirmBrowserRow,
      hostStatusRow);

    // Section 4: Storage & Maintenance
    const dataDirRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'Application Data Directory' }),
        h('div', { class: 'path-display', text: ctx.state.info.dataDir }),
        h('small', { text: `Operating mode: ${ctx.state.info.dataMode} (${ctx.state.info.dataReason})` })),
      h('div', { class: 'setting-control' },
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          onclick: () => ctx.api.shell.openDataFolder(),
        }, icon('folder'), 'Open Folder')));

    const tempFilesRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'Temporary Files' }),
        h('small', { text: `${tempInfo.files || 0} file(s), ${formatBytes(tempInfo.bytes || 0)} used.` })),
      h('div', { class: 'setting-control' },
        h('button', {
          class: 'btn btn-sm btn-danger',
          type: 'button',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Clear Temporary Files?',
              message: 'This will remove intermediate segment files. Paused downloads will be reset if their partial files are removed.',
              confirmLabel: 'Clear Files',
              danger: true,
            });
            if (!ok) return;
            const res = await guard(ctx.api.temp.clear(), 'Temporary files cleared');
            if (res) {
              tempInfo = res;
              render();
            }
          },
        }, icon('trash'), 'Clear Temp')));

    const dbRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'SQLite Database' }),
        h('small', { text: `Size: ${formatBytes(dbInfo.bytes || 0)} | Schema version: ${dbInfo.schemaVersion || 1}` })),
      h('div', { class: 'setting-control' },
        h('button', {
          class: 'btn btn-sm',
          type: 'button',
          onclick: async () => {
            const res = await guard(ctx.api.database.backup());
            if (res && !res.canceled) {
              toast(`Database backed up (${formatBytes(res.bytes)})`, 'ok');
            }
          },
        }, icon('database'), 'Back Up…'),
        h('button', {
          class: 'btn btn-sm btn-danger',
          type: 'button',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Restore Database?',
              message: 'Restoring a database will replace all current history and settings with the contents of the backup. A safety backup of the current database will be saved first.',
              confirmLabel: 'Choose Backup…',
              danger: true,
            });
            if (!ok) return;
            const res = await guard(ctx.api.database.restore());
            if (res && !res.canceled) {
              toast('Database successfully restored', 'ok');
              refresh();
            }
          },
        }, icon('retry'), 'Restore…')));

    const storageCard = h('div', { class: 'card settings-section' },
      h('h2', { text: 'Storage & Database Maintenance' }),
      h('p', { class: 'section-sub', text: 'SQLite database backups, restore, and temporary segment files.' }),
      dataDirRow,
      tempFilesRow,
      dbRow);

    // Section 5: Software Updates & Beta Channel (Milestone 8)
    const channelRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('span', { class: 'label', text: 'Release Channel' }),
        h('small', { text: settings.updateChannel === 'stable' ? 'Stable channel (production releases)' : 'Beta channel (early public beta releases)' })),
      h('div', { class: 'setting-control' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Release channel' },
          ...['beta', 'stable'].map((ch) =>
            h('button', {
              type: 'button',
              'aria-pressed': (settings.updateChannel || 'beta') === ch ? 'true' : 'false',
              text: ch[0].toUpperCase() + ch.slice(1),
              onclick: async () => {
                if (settings.updateChannel !== ch) {
                  const ok = await confirmDialog({
                    title: `Switch to ${ch[0].toUpperCase() + ch.slice(1)} Channel?`,
                    message: ch === 'stable'
                      ? 'Stable channel provides tested production builds once officially released.'
                      : 'Beta channel provides the latest public beta releases with new features.',
                    confirmLabel: `Switch to ${ch[0].toUpperCase() + ch.slice(1)}`,
                  });
                  if (ok) updateSetting({ updateChannel: ch });
                }
              },
            })))));

    const currentChannel = settings.updateChannel || 'beta';
    let statusText = 'Click "Check for Updates" to connect to the secure release server.';
    let statusBadgeClass = 'badge-muted';
    let statusBadgeText = 'Idle';

    if (updateInfo.state === 'checking') {
      statusText = 'Contacting secure HTTPS release endpoint…';
      statusBadgeClass = 'badge-warn';
      statusBadgeText = 'Checking…';
    } else if (updateInfo.state === 'verifying-manifest') {
      statusText = 'Verifying Ed25519 digital signature and canonical release manifest…';
      statusBadgeClass = 'badge-warn';
      statusBadgeText = 'Verifying Signature';
    } else if (updateInfo.state === 'no-update') {
      statusText = `BARQ Downloader v${updateInfo.currentVersion || '0.1.0'} is up to date on the ${currentChannel} channel.`;
      statusBadgeClass = 'badge-ok';
      statusBadgeText = 'Up to Date';
    } else if (updateInfo.state === 'update-available') {
      statusText = `Version v${updateInfo.availableVersion} is available! (Published: ${updateInfo.publishedAt ? new Date(updateInfo.publishedAt).toLocaleDateString() : 'recent'}, Size: ${updateInfo.artifactSize ? formatBytes(updateInfo.artifactSize) : 'N/A'})`;
      statusBadgeClass = 'badge-accent';
      statusBadgeText = `New: v${updateInfo.availableVersion}`;
    } else if (updateInfo.state === 'downloading') {
      statusText = `Downloading update… ${formatBytes(updateInfo.downloadProgress?.downloadedBytes || 0)} of ${formatBytes(updateInfo.downloadProgress?.totalBytes || 0)} (${updateInfo.downloadProgress?.percent || 0}%)`;
      statusBadgeClass = 'badge-accent';
      statusBadgeText = `${updateInfo.downloadProgress?.percent || 0}%`;
    } else if (updateInfo.state === 'verifying-artifact') {
      statusText = 'Verifying cryptographic SHA-256 checksum and Authenticode digital signature…';
      statusBadgeClass = 'badge-warn';
      statusBadgeText = 'Verifying Hash';
    } else if (updateInfo.state === 'ready-to-install') {
      statusText = `Update v${updateInfo.availableVersion} is verified and ready to install. Click "Install & Restart" to proceed.`;
      statusBadgeClass = 'badge-ok';
      statusBadgeText = 'Ready to Install';
    } else if (updateInfo.state === 'failed') {
      statusText = `Update check failed: ${updateInfo.error || 'Server connection error'}`;
      statusBadgeClass = 'badge-danger';
      statusBadgeText = 'Error';
    }

    const updateControls = [];
    if (updateInfo.state === 'update-available') {
      updateControls.push(h('button', {
        class: 'btn btn-sm btn-primary',
        type: 'button',
        onclick: async () => {
          await guard(ctx.api.updater.downloadUpdate());
        },
      }, icon('download'), 'Download Update'));
    } else if (updateInfo.state === 'ready-to-install') {
      updateControls.push(h('button', {
        class: 'btn btn-sm btn-primary',
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog({
            title: `Install BARQ Downloader v${updateInfo.availableVersion}?`,
            message: 'The update is cryptographically verified and ready. The application will close and run the verified installer.',
            confirmLabel: 'Install & Restart',
          });
          if (ok) {
            await ctx.api.updater.installUpdate();
          }
        },
      }, icon('check'), 'Install & Restart'));
    }

    updateControls.push(h('button', {
      class: 'btn btn-sm',
      type: 'button',
      onclick: async () => {
        const res = await guard(ctx.api.updater.checkForUpdates({ channel: currentChannel }));
        if (res) {
          updateInfo = res;
          render();
        }
      },
    }, icon('retry'), 'Check for Updates'));

    const updateStatusRow = h('div', { class: 'setting-row' },
      h('div', { class: 'setting-text' },
        h('div', { class: 'setting-badges' },
          h('span', { class: `badge ${statusBadgeClass}`, text: statusBadgeText }),
          updateInfo.state === 'ready-to-install' ? h('span', { class: 'badge badge-ok', text: '✓ Ed25519 Verified' }) : '',
          updateInfo.state === 'ready-to-install' ? h('span', { class: 'badge badge-ok', text: '✓ SHA-256 Verified' }) : '',
        ),
        h('small', { text: statusText })),
      h('div', { class: 'setting-control' }, ...updateControls));

    const updateCard = h('div', { class: 'card settings-section' },
      h('h2', { text: 'Software Updates & Release Channel' }),
      h('p', { class: 'section-sub', text: 'Secure cryptographic update verification, channel selection, and installation.' }),
      channelRow,
      updateStatusRow);

    container.append(genCard, dlCard, browserCard, storageCard, updateCard);
  }

  async function refresh() {
    try {
      const [s, db, temp, browser, upd] = await Promise.all([
        ctx.api.settings.get(),
        ctx.api.database.info(),
        ctx.api.temp.info(),
        ctx.api.browser ? ctx.api.browser.getStatus() : Promise.resolve({}),
        ctx.api.updater ? ctx.api.updater.getStatus() : Promise.resolve({ state: 'idle' }),
      ]);
      if (disposed) return;
      settings = s;
      dbInfo = db;
      tempInfo = temp;
      browserInfo = browser || {};
      updateInfo = upd || { state: 'idle' };
      render();
    } catch (err) {
      if (!disposed) toast(err.message, 'error');
    }
  }

  let unsubUpdater = null;
  if (ctx.api.updater && typeof ctx.api.updater.onStatusChanged === 'function') {
    unsubUpdater = ctx.api.updater.onStatusChanged((status) => {
      if (disposed) return;
      updateInfo = status;
      render();
    });
  }

  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      if (unsubUpdater) try { unsubUpdater(); } catch {}
    },
  };
}
