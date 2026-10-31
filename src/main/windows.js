'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, nativeTheme, app } = require('electron');
const brand = require('../shared/brand');
const { APP_ORIGIN } = require('./security');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const ICON_PNG = path.join(__dirname, '..', '..', 'assets', 'icons', 'barq-256.png');

const PALETTE = {
  dark: { bg: '#0d0f12', overlay: '#0d0f12', symbol: '#e6e8eb' },
  light: { bg: '#f4f6f8', overlay: '#f4f6f8', symbol: '#1a1d21' },
};

function currentPalette() {
  return nativeTheme.shouldUseDarkColors ? PALETTE.dark : PALETTE.light;
}

function baseWebPreferences(extra = {}) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: !app.isPackaged,
    ...extra,
  };
}

function iconOption() {
  return fs.existsSync(ICON_PNG) ? { icon: ICON_PNG } : {};
}

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 460,
    height: 300,
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    center: true,
    show: false,
    backgroundColor: '#0d0f12',
    title: brand.PRODUCT_NAME,
    ...iconOption(),
    webPreferences: baseWebPreferences(), // no preload: splash is static
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${APP_ORIGIN}/splash.html`);
  return win;
}

function createMainWindow() {
  const p = currentPalette();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    show: false,
    title: brand.PRODUCT_NAME,
    backgroundColor: p.bg,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: p.overlay, symbolColor: p.symbol, height: 40 },
    ...iconOption(),
    webPreferences: baseWebPreferences({ preload: PRELOAD }),
  });

  const onTheme = () => {
    if (win.isDestroyed()) return;
    const c = currentPalette();
    win.setBackgroundColor(c.bg);
    try { win.setTitleBarOverlay({ color: c.overlay, symbolColor: c.symbol, height: 40 }); } catch { /* not supported */ }
  };
  nativeTheme.on('updated', onTheme);
  win.on('closed', () => nativeTheme.removeListener('updated', onTheme));

  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

module.exports = { createSplashWindow, createMainWindow };
