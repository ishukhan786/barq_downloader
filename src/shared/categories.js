'use strict';

const CATEGORY_EXT = {
  video: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts'],
  audio: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'csv', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab'],
  program: ['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'apk', 'dmg'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'ico', 'heic'],
};

const EXT_TO_CATEGORY = new Map();
for (const [cat, exts] of Object.entries(CATEGORY_EXT)) for (const e of exts) EXT_TO_CATEGORY.set(e, cat);

const CATEGORIES = [...Object.keys(CATEGORY_EXT), 'other'];

/** Maps a filename (and optional MIME type) to a display category. */
function categorize(filename, mimeType) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(filename || ''));
  if (m) {
    const cat = EXT_TO_CATEGORY.get(m[1].toLowerCase());
    if (cat) return cat;
  }
  const mt = String(mimeType || '').toLowerCase();
  if (mt.startsWith('video/')) return 'video';
  if (mt.startsWith('audio/')) return 'audio';
  if (mt.startsWith('image/')) return 'image';
  if (mt === 'application/pdf' || mt.startsWith('text/')) return 'document';
  if (/zip|rar|7z|tar|gzip|compressed/.test(mt)) return 'archive';
  return 'other';
}

module.exports = { categorize, CATEGORIES };
