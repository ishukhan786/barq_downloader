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

const EVENT_CHANNELS = new Set(['settings:changed']);

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
    list: (view, search) => call('downloads:list', { view: String(view), search: String(search || '') }),
    remove: (id) => call('downloads:remove', Number(id)),
    showInFolder: (id) => call('downloads:showInFolder', Number(id)),
    copyUrl: (id) => call('downloads:copyUrl', Number(id)),
    queue: () => call('queue:get'),
    validateUrl: (url) => call('url:validate', String(url)),
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
};

// Deep-freeze so page scripts cannot tamper with the bridge.
function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

contextBridge.exposeInMainWorld('barq', deepFreeze(api));
