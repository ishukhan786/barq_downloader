'use strict';

/**
 * Single source of truth for BARQ brand identifiers.
 * Used by the main process; the renderer receives these via IPC (app:getInfo).
 */
module.exports = Object.freeze({
  APP_ID: 'com.barq.downloader',
  PRODUCT_NAME: 'BARQ Downloader',
  BRAND: 'BARQ',
  BRAND_URDU: 'برق',
  PRODUCT_NAME_URDU: 'برق ڈاؤنلوڈر',
  TAGLINE: 'Speed at Every Click.',
  /** Folder name used for the per-user fallback data directory. */
  DATA_FOLDER_NAME: 'BARQ Downloader',
  /** Folder name used beside the executable in portable mode. */
  PORTABLE_FOLDER_NAME: 'portable-data',
  DATABASE_FILE: 'barq.db',
  /** Custom privileged scheme used to serve the renderer. */
  APP_SCHEME: 'barq',
  APP_HOST: 'app',
});
