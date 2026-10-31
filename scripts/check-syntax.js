'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const DIRS_TO_CHECK = ['src', 'scripts', 'tests'];

function getAllJsFiles(dir) {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(getAllJsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

console.log('Checking JavaScript syntax across BARQ Downloader...');
let errorCount = 0;
let fileCount = 0;

for (const dirName of DIRS_TO_CHECK) {
  const dirPath = path.join(ROOT, dirName);
  if (!fs.existsSync(dirPath)) continue;
  const files = getAllJsFiles(dirPath);
  for (const file of files) {
    fileCount++;
    const code = fs.readFileSync(file, 'utf8');
    const isEsm = /^\s*(import|export)\s/m.test(code);
    const args = isEsm ? ['--input-type=module', '--check'] : ['--check', file];
    const opts = isEsm ? { input: code, encoding: 'utf8' } : { encoding: 'utf8' };

    const res = spawnSync(process.execPath, args, opts);
    if (res.status !== 0) {
      console.error(`SYNTAX ERROR in ${path.relative(ROOT, file)}:`);
      console.error(res.stderr || res.stdout);
      errorCount++;
    }
  }
}

if (errorCount > 0) {
  console.error(`Syntax check FAILED with ${errorCount} error(s) across ${fileCount} files.`);
  process.exit(1);
} else {
  console.log(`Syntax check PASSED: all ${fileCount} files (CJS + ESM) parsed cleanly.`);
}
