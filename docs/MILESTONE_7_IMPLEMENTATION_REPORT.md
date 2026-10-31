# BARQ Downloader — Milestone 7 Implementation Report
## Feedback, Diagnostics & Beta Release System

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Version:** 0.1.0  
**Milestone:** 7 — Feedback, Diagnostics & Beta Release System  
**Date:** 2026-10-31  
**Author:** Senior Electron Engineer, Desktop Architect & Security Engineer  

---

## 1. Executive Summary

Milestone 7 delivers a comprehensive, production-grade **Feedback, Diagnostics & Support System** for BARQ Downloader.

The implementation enables users and beta testers to:
1. Log detailed bug reports with categorized severities, reproduction steps, and expected vs. actual behaviors.
2. Submit feature enhancement suggestions with targeted functional categories and value proposals.
3. Manage, edit, search, and delete locally saved feedback records via a dedicated **"My Reports"** management view.
4. Export privacy-verified diagnostic bundles in standardized JSON and PKZIP formats (`BARQ-Diagnostics-YYYY-MM-DD-HH-mm.zip` and `BARQ-Feedback-BARQ-XXXXXX.json`).
5. Inspect diagnostic data before export through an interactive in-app preview modal.
6. Access a built-in **Troubleshooting & Support Center** with step-by-step guidance for download errors, acceleration tuning, pause/resume limits, and browser extension connectivity.

### Core Architectural Mandate: Zero Automatic Telemetry
The system is built on a strict **zero-telemetry, privacy-first foundation**:
- **Zero background network calls**: No data is ever transmitted across the internet without explicit user command.
- **Strict allowlist diagnostic collection**: Only non-identifiable system, runtime, and aggregate performance metrics are gathered.
- **Automatic centralized sanitization**: All URLs, local usernames, user profile directories, IP addresses, credentials, and API tokens are automatically redacted.
- **Zero third-party npm bloat**: Diagnostic packaging is implemented using Node.js built-ins (`node:zlib`, `node:sqlite`, `node:fs`), avoiding supply-chain vulnerabilities.

---

## 2. Implemented & Modified Files

### A. New Modules & Architecture
| File | Responsibility |
|---|---|
| `src/main/db/feedback-repo.js` | SQLite data repository for feedback reports (CRUD, validation, report ID generation, search, stats) |
| `src/main/diagnostics/Sanitizer.js` | Privacy sanitizer redacting URLs, emails, Windows user profile paths, secrets, tokens, and IP addresses |
| `src/main/diagnostics/DiagnosticCollector.js` | Allowlist-only collector aggregating OS, CPU, RAM, runtime environment, telemetry counters, and scrubbed event logs |
| `src/main/diagnostics/ZipExporter.js` | Pure Node.js zero-dependency PKZIP 2.0 archiver and atomic JSON file writer |
| `src/renderer/js/views/feedback.js` | Feedback Center renderer view (KPI metrics, bug form, feature form, reports table, troubleshooting guide, preview modal) |
| `tests/milestone7-feedback.test.js` | 16 comprehensive unit and integration tests verifying schema, CRUD, sanitization, export, and zero-leak boundaries |

### B. Modified Existing Files
| File | Modification Details |
|---|---|
| `src/main/db/migrations.js` | Added migration `version: 4, name: 'feedback_system'` creating `feedback_reports` table and 3 performance indexes |
| `src/main/main.js` | Instantiated `FeedbackRepo` and injected `feedback` into IPC registration pipeline |
| `src/main/ipc.js` | Registered 8 feedback IPC channels (`feedback:getStats`, `feedback:list`, `feedback:get`, `feedback:save`, `feedback:delete`, `feedback:getDiagnosticPreview`, `feedback:exportJson`, `feedback:exportZip`) with dialog handlers and sanitization |
| `src/preload/preload.js` | Exposed typed, deep-frozen `window.barq.feedback` API via contextBridge |
| `src/renderer/index.html` | Added sidebar navigation item **"Feedback & Support"** (`data-nav="feedback"`) with custom SVG icon |
| `src/renderer/js/app.js` | Added `renderFeedback` routing, navigation registration, and active state management |
| `src/renderer/js/dom.js` | Added SVG path definitions for `feedback`, `bug`, `shield`, `export`, and `help` icons |
| `src/renderer/styles/app.css` | Added styling for feedback dashboard, tab buttons, form grids, diagnosis banners, report table badges, and troubleshooting cards |
| `package.json` | Updated test runner script to sequentially run test suites (`--test-concurrency=1`) ensuring zero process/DB lock contention |

---

## 3. Database Migration v4: `feedback_system`

Schema migration v4 executes inside an atomic SQLite transaction:

```sql
CREATE TABLE feedback_reports (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id            TEXT    UNIQUE NOT NULL,
  report_type          TEXT    NOT NULL CHECK (report_type IN ('bug', 'feature')),
  title                TEXT    NOT NULL,
  category             TEXT    NOT NULL,
  severity             TEXT    CHECK (severity IS NULL OR severity IN ('low', 'medium', 'high', 'critical')),
  description          TEXT    NOT NULL,
  reproduction_steps   TEXT,
  expected_behavior    TEXT,
  actual_behavior      TEXT,
  status               TEXT    NOT NULL DEFAULT 'saved' CHECK (status IN ('draft', 'saved', 'exported', 'ready')),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  exported_at          INTEGER,
  diagnostic_included  INTEGER NOT NULL DEFAULT 0 CHECK (diagnostic_included IN (0, 1))
);

CREATE INDEX idx_feedback_created_at ON feedback_reports(created_at DESC);
CREATE INDEX idx_feedback_type       ON feedback_reports(report_type);
CREATE INDEX idx_feedback_status     ON feedback_reports(status);
```

### Report ID Pattern
Every report is assigned an uppercase, collision-resistant identifier formatted as `BARQ-` followed by 6 cryptographic hex characters (e.g. `BARQ-0A1B2C`), allowing easy human reference without revealing record timestamps or system counters.

---

## 4. Diagnostics & Sanitization Architecture

### Allowlist Collector (`DiagnosticCollector`)
The collector operates strictly on explicit permit rules:
- **Operating System:** Platform (`win32`), release (`10.0.x`), architecture (`x64`), total/free memory (MB), CPU model and core count, system uptime.
- **Runtime Environment:** BARQ version (`0.1.0`), Electron (`45.2.1`), Node.js (`22.13.0`), Chrome (`130.0`), V8, SQLite user version.
- **Download Telemetry:** High-level summary metrics only (total downloads, active transfers, queued, paused, completed, failed, overall current speed bps).
- **Recent Logs:** Up to 50 entries from the internal `events` table.

### Central Sanitizer (`Sanitizer`)
Prior to bundling, every string and object property is scrubbed through multi-pass regular expression filters:
1. **Windows Usernames:** Queries `os.userInfo().username` and dynamically replaces all occurrences in paths or strings with `[USER]`.
2. **User Profile Paths:** Matches `C:\Users\<username>\...` and replaces with `C:\Users\[USER]\...`.
3. **HTTP/HTTPS URLs:** Matches `https?://[^\s"'<>]+` and replaces with `[REDACTED_URL]`.
4. **Email Addresses:** Matches standard RFC email patterns and replaces with `[REDACTED_EMAIL]`.
5. **Authorization Tokens:** Matches Bearer tokens, API keys, password parameters, and cookie strings and replaces with `[REDACTED_TOKEN]` or `[REDACTED_SECRET]`.
6. **Network IP Addresses:** Redacts IPv4 and IPv6 addresses with `[REDACTED_IP]` (preserving local loopbacks `127.0.0.1` and `0.0.0.0`).

---

## 5. Pure Node.js Zero-Dependency PKZIP Exporter

To maintain BARQ's zero-dependency footprint and guarantee cross-platform reliability without compiling native C++ addons, `ZipExporter` generates standard PKZIP 2.0 archives using Node's native `node:zlib.deflateRawSync` and `node:zlib.crc32`:

1. **Local File Headers (`0x04034b50`):** Written for each file record with MS-DOS mod dates/times, CRC-32 checksums, and UTF-8 flags (bit 11).
2. **Central Directory Headers (`0x02014b50`):** Consolidated record table specifying relative offsets to local file headers.
3. **End of Central Directory Record (`0x06054b50`):** Trailer detailing entry counts and central directory byte offsets.
4. **Atomic Write Pipeline:** Writes to a temporary staging file (`${destPath}.tmp-${Date.now()}`) before performing an atomic rename, preventing file corruption if export is interrupted.

---

## 6. Security & Preload Bridge

The renderer is sandboxed under context isolation and strict CSP (`script-src 'self'`, `connect-src 'none'`). The preload layer exposes a frozen, type-checked API:

```javascript
window.barq.feedback = Object.freeze({
  getStats: () => call('feedback:getStats'),
  list: (opts) => call('feedback:list', opts || {}),
  get: (id) => call('feedback:get', id),
  save: (report) => call('feedback:save', report),
  delete: (id) => call('feedback:delete', Number(id)),
  getDiagnosticPreview: (opts) => call('feedback:getDiagnosticPreview', opts || {}),
  exportJson: (idOrOpts) => call('feedback:exportJson', idOrOpts),
  exportZip: (idOrOpts) => call('feedback:exportZip', idOrOpts),
});
```

---

## 7. Verification & Smoke Test Results

- **Syntax Audit (`npm run syntax`):** Passed cleanly across all 64 files.
- **Unit & Integration Suite (`npm test`):** 148 passed out of 148 tests (100% pass rate).
- **Smoke Check (`npm run smoke`):** Verified UI ready marker, navigation links, context isolation, frozen API, and migration v4 initialization.
