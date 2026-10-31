'use strict';

const path = require('node:path');

/**
 * Declarative settings schema. Every write from the renderer is validated
 * against this; unknown keys are rejected.
 *
 * `rendererWritable: false` keys can only be changed by the main process
 * (e.g. via a native folder picker) — never with a raw value from the UI.
 */
function int(min, max) {
  return (v) => (Number.isSafeInteger(v) && v >= min && v <= max ? v : undefined);
}
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...opts) => (v) => (opts.includes(v) ? v : undefined);
const absPathOrEmpty = (v) => (typeof v === 'string' && (v === '' || (path.isAbsolute(v) && !v.includes('\0') && v.length < 1024)) ? v : undefined);

function buildSchema({ defaultDownloadDir }) {
  return {
    downloadDir:            { default: defaultDownloadDir, validate: absPathOrEmpty, rendererWritable: false },
    maxConcurrentDownloads: { default: 3, validate: int(1, 16), rendererWritable: true },
    maxSegments:            { default: 4, validate: int(1, 16), rendererWritable: true },
    connectionsPerFile:     { default: 8, validate: int(1, 16), rendererWritable: true },
    maxConnections:         { default: 16, validate: int(1, 32), rendererWritable: true },
    autoSegmentation:       { default: true, validate: bool, rendererWritable: true },
    autoFallback:           { default: true, validate: bool, rendererWritable: true },
    minSegmentSize:         { default: 5242880, validate: int(1024, 104857600), rendererWritable: true }, // 5 MB
    globalSpeedLimitKBps:   { default: 0, validate: int(0, 10_000_000), rendererWritable: true }, // 0 = unlimited
    theme:                  { default: 'dark', validate: oneOf('dark', 'light', 'system'), rendererWritable: true },
    notifications:          { default: true, validate: bool, rendererWritable: true },
    autoStart:              { default: false, validate: bool, rendererWritable: true },
    browserIntegration:     { default: false, validate: bool, rendererWritable: true },
    confirmBrowserDownloads:{ default: true, validate: bool, rendererWritable: true },
    videoEngineDir:         { default: '', validate: absPathOrEmpty, rendererWritable: false },
    deletePartialOnCancel:  { default: false, validate: bool, rendererWritable: true },
    updateChannel:          { default: 'beta', validate: oneOf('beta', 'stable'), rendererWritable: true },
  };
}

module.exports = { buildSchema };
