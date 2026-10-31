'use strict';

/**
 * Rasterises the BARQ mark (SVG) into PNGs and a multi-resolution Windows .ico.
 * Run with:  npm run icons   (executes inside Electron; no third-party deps)
 *
 * Output: assets/icons/barq-{16..512}.png, assets/icons/barq.ico
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'assets', 'brand', 'barq-mark.svg');
const OUT = path.join(ROOT, 'assets', 'icons');
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// 512 keeps the offscreen window smaller than any display's work area (windows get clamped).
const RENDER = 512;

/** Builds an ICO container with PNG-compressed entries (supported since Windows Vista). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach(({ size, png }, i) => {
    const o = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += png.length;
  });
  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

app.disableHardwareAcceleration();
// Render at exactly 1 CSS px = 1 device px regardless of the monitor's DPI scaling.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');
app.whenReady().then(async () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const svg = fs.readFileSync(SRC, 'utf8').replace(/width="512" height="512"/, `width="${RENDER}" height="${RENDER}"`);
    const html = `<!doctype html><html><head><style>html,body{margin:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;
    const win = new BrowserWindow({
      width: RENDER, height: RENDER, show: false, frame: false, transparent: true, useContentSize: true,
      webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: false },
    });
    win.webContents.setFrameRate(1);
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    await new Promise((r) => setTimeout(r, 500));
    const captured = await win.webContents.capturePage({ x: 0, y: 0, width: RENDER, height: RENDER });
    const sz = captured.getSize();
    if (sz.width !== RENDER || sz.height !== RENDER) {
      throw new Error(`Unexpected capture size ${sz.width}x${sz.height} (expected ${RENDER}x${RENDER})`);
    }
    const full = captured;
    const pngs = {};
    for (const size of PNG_SIZES) {
      const img = full.resize({ width: size, height: size, quality: 'best' });
      pngs[size] = img.toPNG();
      fs.writeFileSync(path.join(OUT, `barq-${size}.png`), pngs[size]);
    }
    const ico = buildIco(ICO_SIZES.map((size) => ({ size, png: pngs[size] })));
    fs.writeFileSync(path.join(OUT, 'barq.ico'), ico);
    console.log(`Icons written to ${OUT}: ${PNG_SIZES.map((s) => s + 'px').join(', ')} + barq.ico (${ico.length} bytes)`);
    app.exit(0);
  } catch (err) {
    console.error('Icon build failed:', err);
    app.exit(1);
  }
});
