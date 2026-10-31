'use strict';

const crypto = require('node:crypto');

const VALID_TYPES = new Set(['bug', 'feature']);
const VALID_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const VALID_STATUSES = new Set(['draft', 'saved', 'exported', 'ready']);

const BUG_CATEGORIES = Object.freeze([
  'download_failure',
  'speed_performance',
  'pause_resume',
  'multi_segment',
  'ui_ux',
  'browser_extension',
  'crash_freeze',
  'other',
]);

const FEATURE_CATEGORIES = Object.freeze([
  'download_engine',
  'user_interface',
  'browser_integration',
  'queue_scheduling',
  'automation',
  'other',
]);

const LIST_COLUMNS = `id, report_id, report_type, title, category, severity,
  description, reproduction_steps, expected_behavior, actual_behavior,
  status, created_at, updated_at, exported_at, diagnostic_included`;

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (c) => `\\${c}`);
}

class FeedbackRepo {
  /**
   * @param {import('./database').BarqDatabase} database
   */
  constructor(database) {
    this.database = database;
  }

  generateReportId() {
    const hex = crypto.randomBytes(3).toString('hex').toUpperCase();
    return `BARQ-${hex}`;
  }

  /**
   * Validates feedback payload. Throws ValidationError on mismatch.
   */
  validate(data, isUpdate = false) {
    if (!data || typeof data !== 'object') {
      throw new Error('Feedback data must be an object.');
    }

    if (!isUpdate || data.report_type !== undefined) {
      if (!VALID_TYPES.has(data.report_type)) {
        throw new Error(`Invalid report type "${data.report_type}". Must be 'bug' or 'feature'.`);
      }
    }

    if (!isUpdate || data.title !== undefined) {
      if (typeof data.title !== 'string' || !data.title.trim()) {
        throw new Error('Title is required and must not be empty.');
      }
      if (data.title.trim().length > 200) {
        throw new Error('Title cannot exceed 200 characters.');
      }
    }

    if (!isUpdate || data.category !== undefined) {
      if (typeof data.category !== 'string' || !data.category.trim()) {
        throw new Error('Category is required.');
      }
      const allowedCategories = (data.report_type === 'bug' || (!data.report_type && !isUpdate))
        ? BUG_CATEGORIES
        : FEATURE_CATEGORIES;
      if (!BUG_CATEGORIES.includes(data.category) && !FEATURE_CATEGORIES.includes(data.category)) {
        throw new Error(`Invalid category "${data.category}".`);
      }
    }

    if (data.severity !== undefined && data.severity !== null && data.severity !== '') {
      if (!VALID_SEVERITIES.has(data.severity)) {
        throw new Error(`Invalid severity "${data.severity}". Must be one of: low, medium, high, critical.`);
      }
    }

    if (!isUpdate || data.description !== undefined) {
      if (typeof data.description !== 'string' || !data.description.trim()) {
        throw new Error('Description is required.');
      }
      if (data.description.trim().length > 5000) {
        throw new Error('Description cannot exceed 5000 characters.');
      }
    }

    if (data.status !== undefined) {
      if (!VALID_STATUSES.has(data.status)) {
        throw new Error(`Invalid status "${data.status}". Must be one of: draft, saved, exported, ready.`);
      }
    }
  }

  create(data) {
    this.validate(data, false);

    const reportId = data.report_id || this.generateReportId();
    const now = Date.now();
    const severity = data.severity && VALID_SEVERITIES.has(data.severity) ? data.severity : null;
    const status = data.status && VALID_STATUSES.has(data.status) ? data.status : 'saved';
    const diagIncluded = data.diagnostic_included ? 1 : 0;

    const stmt = this.database.prepare(`
      INSERT INTO feedback_reports (
        report_id, report_type, title, category, severity,
        description, reproduction_steps, expected_behavior, actual_behavior,
        status, created_at, updated_at, exported_at, diagnostic_included
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      reportId,
      data.report_type,
      data.title.trim(),
      data.category.trim(),
      severity,
      data.description.trim(),
      data.reproduction_steps ? String(data.reproduction_steps).trim().slice(0, 5000) : null,
      data.expected_behavior ? String(data.expected_behavior).trim().slice(0, 2000) : null,
      data.actual_behavior ? String(data.actual_behavior).trim().slice(0, 2000) : null,
      status,
      now,
      now,
      null,
      diagIncluded
    );

    return this.getById(result.lastInsertRowid);
  }

  getById(id) {
    const numId = Number(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) return null;
    return this.database.prepare(`SELECT ${LIST_COLUMNS} FROM feedback_reports WHERE id = ?`).get(numId) || null;
  }

  getByReportId(reportId) {
    if (typeof reportId !== 'string' || !reportId.trim()) return null;
    return this.database.prepare(`SELECT ${LIST_COLUMNS} FROM feedback_reports WHERE report_id = ?`).get(reportId.trim()) || null;
  }

  list({ type = null, status = null, search = '', limit = 100, offset = 0 } = {}) {
    const params = [];
    const clauses = [];

    if (type && VALID_TYPES.has(type)) {
      clauses.push('report_type = ?');
      params.push(type);
    }

    if (status && VALID_STATUSES.has(status)) {
      clauses.push('status = ?');
      params.push(status);
    }

    const term = typeof search === 'string' ? search.trim().slice(0, 200) : '';
    if (term) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR report_id LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(term)}%`;
      params.push(like, like, like);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const lim = Number.isSafeInteger(limit) && limit > 0 && limit <= 500 ? limit : 100;
    const off = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;

    params.push(lim, off);

    const sql = `SELECT ${LIST_COLUMNS} FROM feedback_reports ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
    return this.database.prepare(sql).all(...params);
  }

  update(id, data) {
    const existing = this.getById(id);
    if (!existing) {
      throw new Error(`Report #${id} not found.`);
    }

    this.validate(data, true);

    const fields = [];
    const params = [];

    if (data.title !== undefined) {
      fields.push('title = ?');
      params.push(data.title.trim());
    }
    if (data.category !== undefined) {
      fields.push('category = ?');
      params.push(data.category.trim());
    }
    if (data.severity !== undefined) {
      fields.push('severity = ?');
      params.push(data.severity && VALID_SEVERITIES.has(data.severity) ? data.severity : null);
    }
    if (data.description !== undefined) {
      fields.push('description = ?');
      params.push(data.description.trim());
    }
    if (data.reproduction_steps !== undefined) {
      fields.push('reproduction_steps = ?');
      params.push(data.reproduction_steps ? String(data.reproduction_steps).trim().slice(0, 5000) : null);
    }
    if (data.expected_behavior !== undefined) {
      fields.push('expected_behavior = ?');
      params.push(data.expected_behavior ? String(data.expected_behavior).trim().slice(0, 2000) : null);
    }
    if (data.actual_behavior !== undefined) {
      fields.push('actual_behavior = ?');
      params.push(data.actual_behavior ? String(data.actual_behavior).trim().slice(0, 2000) : null);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      params.push(data.status);
    }
    if (data.diagnostic_included !== undefined) {
      fields.push('diagnostic_included = ?');
      params.push(data.diagnostic_included ? 1 : 0);
    }

    if (!fields.length) return existing;

    fields.push('updated_at = ?');
    params.push(Date.now());

    params.push(Number(id));

    this.database.prepare(`UPDATE feedback_reports SET ${fields.join(', ')} WHERE id = ?`).run(...params);
    return this.getById(id);
  }

  delete(id) {
    const numId = Number(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) return false;
    const res = this.database.prepare('DELETE FROM feedback_reports WHERE id = ?').run(numId);
    return res.changes > 0;
  }

  markExported(id) {
    const numId = Number(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) return null;
    const now = Date.now();
    this.database.prepare(`
      UPDATE feedback_reports
      SET status = 'exported', exported_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, numId);
    return this.getById(numId);
  }

  getStats() {
    const rows = this.database.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN report_type = 'bug' THEN 1 ELSE 0 END) as bugs,
        SUM(CASE WHEN report_type = 'feature' THEN 1 ELSE 0 END) as features,
        SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) as drafts,
        SUM(CASE WHEN status = 'saved' THEN 1 ELSE 0 END) as saved,
        SUM(CASE WHEN status = 'exported' THEN 1 ELSE 0 END) as exported
      FROM feedback_reports
    `).get();

    return {
      total: Number(rows.total) || 0,
      bugs: Number(rows.bugs) || 0,
      features: Number(rows.features) || 0,
      drafts: Number(rows.drafts) || 0,
      saved: Number(rows.saved) || 0,
      exported: Number(rows.exported) || 0,
    };
  }
}

module.exports = {
  FeedbackRepo,
  VALID_TYPES,
  VALID_SEVERITIES,
  VALID_STATUSES,
  BUG_CATEGORIES,
  FEATURE_CATEGORIES,
};
