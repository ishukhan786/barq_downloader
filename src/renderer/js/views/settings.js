// Settings view: general, engine, database, and system options
import { h, icon, clear } from '../dom.js';
import { formatBytes } from '../format.js';
import { confirmDialog, guard, toast } from '../ui.js';

export function renderSettings(root, ctx) {
  let settings = {};
  let dbInfo = {};
  let tempInfo = {};
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

    const browserCard = h('div', { class: 'card settings-section' },
      h('h2', { text: 'Browser Extensions' }),
      h('p', { class: 'section-sub', text: 'Integration with Chrome and Microsoft Edge (Milestone 4).' }),
      bridgeRow,
      confirmBrowserRow);

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

    container.append(genCard, dlCard, browserCard, storageCard);
  }

  async function refresh() {
    try {
      const [s, db, temp] = await Promise.all([
        ctx.api.settings.get(),
        ctx.api.database.info(),
        ctx.api.temp.info(),
      ]);
      if (disposed) return;
      settings = s;
      dbInfo = db;
      tempInfo = temp;
      render();
    } catch (err) {
      if (!disposed) toast(err.message, 'error');
    }
  }

  refresh();
  return {
    refresh,
    dispose() { disposed = true; },
  };
}
