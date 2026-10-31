'use strict';

/**
 * BARQ secure preload.
 *
 * Runs sandboxed with contextIsolation. Exposes a narrow, typed API as
 * `window.barq`. The renderer never receives ipcRenderer, Node.js, or
 * filesystem access. Each function maps to exactly one allowlisted channel;
 * all inputs are re-validated in the main process.
 */
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, arg) {
  const res = arg === undefined ? await ipcRenderer.invoke(channel) : await ipcRenderer.invoke(channel, arg);
  if (!res || res.ok !== true) throw new Error((res && res.error) || 'Request failed');
  return res.data;
}

const EVENT_CHANNELS = new Set([
  'settings:changed',
  'download:progress',
  'download:state-changed',
  'updater:status-changed',
]);

function subscribe(channel, callback) {
  if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  app: {
    getInfo: () => call('app:getInfo'),
  },
  stats: {
    get: () => call('stats:get'),
  },
  downloads: {
    list: (viewOrOpts, search) => {
      if (typeof viewOrOpts === 'object' && viewOrOpts !== null) {
        return call('downloads:list', { view: String(viewOrOpts.view || 'all'), search: String(viewOrOpts.search || '') });
      }
      return call('downloads:list', { view: String(viewOrOpts || 'all'), search: String(search || '') });
    },
    add: (params) => call('downloads:add', params),
    probe: (url) => call('downloads:probe', String(url)),
    pause: (id) => call('downloads:pause', Number(id)),
    resume: (id) => call('downloads:resume', Number(id)),
    cancel: (id, deletePartial = false) => call('downloads:cancel', { id: Number(id), deletePartial: Boolean(deletePartial) }),
    retry: (id) => call('downloads:retry', Number(id)),
    remove: (id) => call('downloads:remove', Number(id)),
    showInFolder: (id) => call('downloads:showInFolder', Number(id)),
    openFile: (id) => call('downloads:openFile', Number(id)),
    details: (id) => call('downloads:details', Number(id)),
    chooseDestination: () => call('downloads:chooseDestination'),
    copyUrl: (id) => call('downloads:copyUrl', Number(id)),
    queue: () => call('queue:get'),
    validateUrl: (url) => call('url:validate', String(url)),
    onProgress: (cb) => subscribe('download:progress', cb),
    onStateChanged: (cb) => subscribe('download:state-changed', cb),
  },
  activity: {
    recent: () => call('activity:recent'),
  },
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
    chooseDownloadDir: () => call('settings:chooseDownloadDir'),
    onChanged: (cb) => subscribe('settings:changed', cb),
  },
  database: {
    info: () => call('db:info'),
    backup: () => call('db:backup'),
    restore: () => call('db:restore'),
  },
  temp: {
    info: () => call('temp:info'),
    clear: () => call('temp:clear'),
  },
  shell: {
    openExternal: (key) => call('shell:openExternal', String(key)),
    openDataFolder: () => call('shell:openDataFolder'),
  },
  browser: {
    getStatus: () => call('browser:getStatus'),
    register: () => call('browser:register'),
  },
  feedback: {
    getStats: () => call('feedback:getStats'),
    list: (opts) => call('feedback:list', opts || {}),
    get: (id) => call('feedback:get', id),
    save: (report) => call('feedback:save', report),
    delete: (id) => call('feedback:delete', Number(id)),
    getDiagnosticPreview: (opts) => call('feedback:getDiagnosticPreview', opts || {}),
    exportJson: (idOrOpts) => call('feedback:exportJson', idOrOpts),
    exportZip: (idOrOpts) => call('feedback:exportZip', idOrOpts),
  },
  updater: {
    getStatus: () => call('updater:getStatus'),
    checkForUpdates: (opts) => call('updater:checkForUpdates', opts || {}),
    downloadUpdate: () => call('updater:downloadUpdate'),
    installUpdate: () => call('updater:installUpdate'),
    cancelUpdate: () => call('updater:cancelUpdate'),
    onStatusChanged: (cb) => subscribe('updater:status-changed', cb),
  },
};

// Deep-freeze so page scripts cannot tamper with the bridge.
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

contextBridge.exposeInMainWorld('barq', deepFreeze(api));
