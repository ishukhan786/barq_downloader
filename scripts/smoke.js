'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DATA_DIR = path.join(ROOT, 'test-data', `smoke-${Date.now()}`);

console.log('Running BARQ Downloader Smoke Test...');
console.log('Isolated Smoke Data Directory:', TEST_DATA_DIR);

fs.mkdirSync(TEST_DATA_DIR, { recursive: true });

const electronPath = require('electron');

const env = {
  ...process.env,
  BARQ_SMOKE: '1',
  BARQ_DATA_DIR: TEST_DATA_DIR,
};

const child = spawn(electronPath, ['.'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';

child.stdout.on('data', (d) => {
  const str = d.toString('utf8');
  stdout += str;
  process.stdout.write(str);
});

child.stderr.on('data', (d) => {
  const str = d.toString('utf8');
  stderr += str;
  process.stderr.write(str);
});

const timer = setTimeout(() => {
  console.error('\nSmoke test timed out after 45 seconds.');
  try { child.kill('SIGKILL'); } catch {}
  process.exit(1);
}, 45000);

child.on('close', (code) => {
  clearTimeout(timer);
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch (err) {
    console.warn('Could not clean test data dir:', err.message);
  }

  const match = stdout.match(/BARQ_SMOKE_RESULT\s+(.*)/);
  if (!match) {
    console.error('\nSmoke test failed: Did not receive BARQ_SMOKE_RESULT from Electron process.');
    console.error('Exit code:', code);
    process.exit(1);
  }

  try {
    const parsed = JSON.parse(match[1]);
    if (!parsed.ok) {
      console.error('\nSmoke test reported error:', parsed.error);
      process.exit(1);
    }

    console.log('\n--- BARQ SMOKE TEST REPORT ---');
    console.log(JSON.stringify(parsed.report, null, 2));

    const rep = parsed.report;
    const checks = [
      ['UI Ready marker', rep.ready === true],
      ['Context isolation (require undefined)', rep.typeofRequire === 'undefined'],
      ['Process not exposed', rep.typeofProcess === 'undefined'],
      ['Module not exposed', rep.typeofModule === 'undefined'],
      ['barq API frozen', rep.barqFrozen === true],
      ['Inline script blocked by CSP', rep.inlineScriptBlocked === true],
      ['Renderer network fetch blocked', rep.fetchBlocked === true],
      ['Main-only setting update rejected', rep.mainOnlySettingRejected === true],
      ['Unknown setting update rejected', rep.unknownSettingRejected === true],
      ['Dangerous file URL rejected', rep.fileUrlRejected === true],
      ['Database schema initialized', rep.schemaVersion >= 1],
      ['Navigation buttons present', Array.isArray(rep.nav) && rep.nav.length >= 8],
    ];

    let allPassed = true;
    for (const [name, passed] of checks) {
      console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
      if (!passed) allPassed = false;
    }

    if (!allPassed) {
      console.error('\nSmoke test failed verification assertions.');
      process.exit(1);
    }

    console.log('\nSmoke test SUCCESSFUL. All verification checks passed.');
    process.exit(0);
  } catch (err) {
    console.error('\nFailed to parse smoke test output:', err);
    process.exit(1);
  }
});
