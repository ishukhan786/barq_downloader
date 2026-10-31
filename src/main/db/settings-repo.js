'use strict';

/**
 * Settings repository. Values are stored as JSON text. Reads always go
 * through the schema so corrupt/unknown values fall back to defaults.
 */
class SettingsRepo {
  constructor(database, schema) {
    this.database = database;
    this.schema = schema;
  }

  getAll() {
    const out = {};
    for (const [key, def] of Object.entries(this.schema)) out[key] = def.default;
    const rows = this.database.prepare('SELECT key, value FROM settings').all();
    for (const { key, value } of rows) {
      const def = this.schema[key];
      if (!def) continue;
      let parsed;
      try { parsed = JSON.parse(value); } catch { continue; }
      const valid = def.validate(parsed);
      if (valid !== undefined) out[key] = valid;
    }
    return out;
  }

  get(key) {
    return this.getAll()[key];
  }

  /**
   * Validates and persists a partial update atomically.
   * @param {object} patch
   * @param {{ trusted?: boolean }} [opts] trusted=true allows main-only keys.
   * @returns {{ ok: true, settings: object, changed: string[] } | { ok: false, error: string }}
   */
  update(patch, { trusted = false } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'Settings update must be an object.' };
    }
    const entries = Object.entries(patch);
    if (entries.length === 0 || entries.length > 32) return { ok: false, error: 'Invalid settings update.' };
    const clean = [];
    for (const [key, value] of entries) {
      const def = Object.prototype.hasOwnProperty.call(this.schema, key) ? this.schema[key] : null;
      if (!def) return { ok: false, error: `Unknown setting "${key}".` };
      if (!trusted && !def.rendererWritable) return { ok: false, error: `Setting "${key}" cannot be changed directly.` };
      const valid = def.validate(value);
      if (valid === undefined) return { ok: false, error: `Invalid value for "${key}".` };
      clean.push([key, valid]);
    }
    const now = Date.now();
    this.database.transaction((db) => {
      const stmt = db.prepare(
        'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      );
      for (const [key, value] of clean) stmt.run(key, JSON.stringify(value), now);
    });
    return { ok: true, settings: this.getAll(), changed: clean.map(([k]) => k) };
  }
}

module.exports = { SettingsRepo };
