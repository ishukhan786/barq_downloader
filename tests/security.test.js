'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  validateDownloadUrl,
  isPathInside,
  safeJoin,
  sanitizeFilename,
  validateId,
} = require('../src/main/security');

test('security: validateDownloadUrl accepts clean http and https URLs', () => {
  const r1 = validateDownloadUrl('https://example.com/file.zip');
  assert.equal(r1.ok, true);
  assert.equal(r1.url, 'https://example.com/file.zip');

  const r2 = validateDownloadUrl('http://downloads.test/app-1.0.exe?sig=abc');
  assert.equal(r2.ok, true);
  assert.equal(r2.url, 'http://downloads.test/app-1.0.exe?sig=abc');
});

test('security: validateDownloadUrl rejects illegal schemes and dangerous protocols', () => {
  assert.equal(validateDownloadUrl('file:///C:/Windows/System32/cmd.exe').ok, false);
  assert.equal(validateDownloadUrl('javascript:alert(1)').ok, false);
  assert.equal(validateDownloadUrl('data:text/html,evil').ok, false);
  assert.equal(validateDownloadUrl('ftp://example.com/file.zip').ok, false);
  assert.equal(validateDownloadUrl('ws://example.com/socket').ok, false);
});

test('security: validateDownloadUrl rejects credentials and control characters', () => {
  assert.equal(validateDownloadUrl('https://user:password@example.com/test').ok, false);
  assert.equal(validateDownloadUrl('https://example.com/test\x00file').ok, false);
  assert.equal(validateDownloadUrl('https://example.com/test\r\nfile').ok, false);
  assert.equal(validateDownloadUrl('').ok, false);
  assert.equal(validateDownloadUrl('   ').ok, false);
  assert.equal(validateDownloadUrl(12345).ok, false);
});

test('security: sanitizeFilename strips directory traversal and Windows reserved names', () => {
  assert.equal(sanitizeFilename('../../evil.exe'), 'evil.exe');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\calc.exe'), 'calc.exe');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('AUX.zip'), '_AUX.zip');
  assert.equal(sanitizeFilename('NUL'), '_NUL');
  assert.equal(sanitizeFilename('test:stream*?.bin'), 'test_stream__.bin');
  assert.equal(sanitizeFilename('   spaces.pdf   '), 'spaces.pdf');
  assert.equal(sanitizeFilename(''), 'download');
});

test('security: isPathInside prevents directory traversal attacks', () => {
  const base = path.resolve('D:\\Projects\\BARQ_DOWNLOADER\\dev-data\\temp');
  assert.equal(isPathInside(base, path.join(base, 'file.bin')), true);
  assert.equal(isPathInside(base, path.join(base, 'sub', 'file.bin')), true);

  // Escaping base
  assert.equal(isPathInside(base, path.join(base, '..', 'barq.db')), false);
  assert.equal(isPathInside(base, 'C:\\Windows\\System32'), false);
});

test('security: safeJoin resolves safely and returns null on traversal', () => {
  const base = path.resolve('D:\\Projects\\BARQ_DOWNLOADER\\src\\renderer');
  assert.notEqual(safeJoin(base, 'index.html'), null);
  assert.notEqual(safeJoin(base, 'styles/app.css'), null);
  assert.equal(safeJoin(base, '../main/main.js'), null);
  assert.equal(safeJoin(base, '..\\..\\package.json'), null);
  assert.equal(safeJoin(base, 'evil\0null.js'), null);
});

test('security: validateId allows positive safe integers only', () => {
  assert.equal(validateId(1), 1);
  assert.equal(validateId(9999), 9999);
  assert.equal(validateId(0), null);
  assert.equal(validateId(-5), null);
  assert.equal(validateId(3.14), null);
  assert.equal(validateId('1'), null);
  assert.equal(validateId(null), null);
  assert.equal(validateId(NaN), null);
});
