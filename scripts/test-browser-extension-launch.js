'use strict';

const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_DIR = path.resolve(__dirname, '..', 'browser-extension');

async function testBrowser(name, exePath) {
  if (!fs.existsSync(exePath)) {
    return { browser: name, status: 'NOT_INSTALLED', error: `Binary not found at ${exePath}` };
  }

  const profileDir = path.resolve(__dirname, '..', 'dev-data', `${name.toLowerCase()}-verify-profile`);
  fs.mkdirSync(profileDir, { recursive: true });

  const port = 9333 + (name === 'Edge' ? 1 : 0);

  console.log(`[TEST] Launching ${name} with extension...`);
  const proc = spawn(exePath, [
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${EXTENSION_DIR}`,
    `--load-extension=${EXTENSION_DIR}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  let verified = false;
  let targets = [];

  for (let attempt = 0; attempt < 25; attempt++) {
    await wait(300);
    try {
      const data = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.setTimeout(500, () => req.destroy());
      });

      targets = data;
      const extensionTarget = targets.find((t) =>
        t.url && (t.url.includes('chrome-extension://') || t.url.includes('extension://') || t.title.includes('BARQ'))
      );

      if (extensionTarget) {
        verified = true;
        console.log(`[PASS] ${name}: Extension target discovered:`, {
          title: extensionTarget.title,
          type: extensionTarget.type,
          url: extensionTarget.url,
        });
        break;
      }
    } catch {}
  }

  // Gracefully terminate browser process
  try {
    proc.kill();
  } catch {}

  return {
    browser: name,
    verified,
    targetCount: targets.length,
    targets: targets.map((t) => ({ type: t.type, title: t.title, url: t.url })),
  };
}

async function run() {
  console.log('--- BROWSER EXTENSION VERIFICATION ---');
  const chromeRes = await testBrowser('Chrome', CHROME_PATH);
  const edgeRes = await testBrowser('Edge', EDGE_PATH);

  console.log('\n--- VERIFICATION SUMMARY ---');
  console.log('Chrome:', chromeRes.verified ? 'LOADED & VERIFIED' : 'FAILED', chromeRes);
  console.log('Edge:  ', edgeRes.verified ? 'LOADED & VERIFIED' : 'FAILED', edgeRes);
}

run().catch((err) => {
  console.error('Browser test failed:', err);
  process.exit(1);
});
