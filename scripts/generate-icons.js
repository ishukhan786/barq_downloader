'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

function generateBarqIcon(size) {
  const width = size;
  const height = size;
  const rowSize = 1 + width * 4;
  const rawData = Buffer.alloc(rowSize * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowSize;
    rawData[rowOffset] = 0; // Filter: None
    const ny = y / height; // 0..1

    for (let x = 0; x < width; x++) {
      const pxOffset = rowOffset + 1 + x * 4;
      const nx = x / width; // 0..1

      // 1. Background: rounded graphite badge
      const cx = 0.5;
      const cy = 0.5;
      const dist = Math.hypot(nx - cx, ny - cy);

      if (dist > 0.48) {
        // Transparent border
        rawData[pxOffset + 3] = 0;
        continue;
      }

      // 2. Base graphite color (#0B0E14)
      let r = 11;
      let g = 14;
      let b = 20;
      let a = 255;

      // 3. Lightning bolt shape inside badge
      // Upper diagonal: (0.55, 0.15) to (0.35, 0.50)
      // Horizontal jog: (0.35, 0.50) to (0.50, 0.48)
      // Lower diagonal: (0.50, 0.48) to (0.42, 0.85)
      let isBolt = false;
      if (ny >= 0.15 && ny < 0.50) {
        // Slanted upper bar
        const centerLine = 0.60 - (ny - 0.15) * 0.70;
        if (Math.abs(nx - centerLine) < 0.12) isBolt = true;
      } else if (ny >= 0.45 && ny <= 0.85) {
        // Lower slanted bar
        const centerLine = 0.52 - (ny - 0.45) * 0.35;
        const widthTaper = 0.10 * (1 - (ny - 0.45) / 0.40);
        if (Math.abs(nx - centerLine) < Math.max(widthTaper, 0.02)) isBolt = true;
      }

      if (isBolt) {
        // Electric emerald green (#10B981)
        r = 16;
        g = 185;
        b = 129;
      } else if (dist > 0.42) {
        // Border ring: muted emerald
        r = 5;
        g = 150;
        b = 105;
      }

      rawData[pxOffset] = r;
      rawData[pxOffset + 1] = g;
      rawData[pxOffset + 2] = b;
      rawData[pxOffset + 3] = a;
    }
  }

  const deflated = zlib.deflateSync(rawData);

  function makeChunk(type, data) {
    const len = data.length;
    const buf = Buffer.alloc(12 + len);
    buf.writeUInt32BE(len, 0);
    buf.write(type, 4, 4, 'ascii');
    data.copy(buf, 8);
    const crc = zlib.crc32(buf.subarray(4, 8 + len));
    buf.writeUInt32BE(crc, 8 + len);
    return buf;
  }

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', deflated),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconsDir = path.resolve(__dirname, '..', 'browser-extension', 'icons');
fs.mkdirSync(iconsDir, { recursive: true });

for (const size of [16, 48, 128]) {
  const png = generateBarqIcon(size);
  const target = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(target, png);
  console.log(`Generated: ${target} (${png.length} bytes)`);
}
