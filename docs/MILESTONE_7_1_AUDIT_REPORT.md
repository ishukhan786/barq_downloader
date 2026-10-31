# BARQ DOWNLOADER — MILESTONE 7.1 AUDIT REPORT
## Final Privacy, Diagnostics & Release Readiness Audit

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Version:** 0.1.0  
**Target Platform:** Windows 10/11 x64  
**Date:** November 1, 2026  
**Status:** FULLY VERIFIED & CSP COMPLIANT  

---

### Executive Summary

Milestone 7.1 was executed as a strict corrective, privacy, and release-readiness verification milestone for BARQ Downloader. The audit thoroughly reviewed the diagnostics pipeline, the feedback and error reporting system, database schema modeling, Content Security Policy enforcement, and network telemetry guarantees.

All identified privacy risks, schema ambiguities, and CSP violations have been systematically resolved and verified against the automated test suite (153/153 passing tests) and Electron runtime smoke checks.

---

### 1. Privacy Audit & Redaction Verification

BARQ Downloader enforces a strict zero-leak privacy policy for all feedback reports and diagnostic exports. The `Sanitizer` module (`src/main/diagnostics/Sanitizer.js`) was audited and upgraded to prevent leakage of sensitive identifiers:

| Category | Vulnerability Surface | Redaction Strategy & Implementation | Status |
| :--- | :--- | :--- | :--- |
| **URLs & Query Strings** | Download source links, auth query tokens (`?token=...`, `?key=...`) | Regular expressions scrub all protocol schemes (`http://`, `https://`, `ftp://`, `ws://`, `wss://`, `file://`) -> `[REDACTED_URL]` | VERIFIED |
| **IP Addresses** | Server IPs, router IPs, DNS endpoints | IPv4 addresses scrubbed to `[REDACTED_IP]` (loopback `127.0.0.1` preserved for local testing). Comprehensive IPv6 parser redacts standard, compressed, and mapped IPv6 -> `[REDACTED_IP]` | VERIFIED |
| **UNC Network Paths** | SMB/Windows share paths (`\\server\share\...`, `//server/share/...`) | Lookbehind-guarded pattern replaces network paths with `[REDACTED_UNC_PATH]`, preventing UNC matching from eating URL protocols | VERIFIED |
| **Windows Usernames & Profiles** | Windows account names, user profile folders | `os.userInfo().username` and `%USERNAME%` dynamically extracted; `C:\Users\<user>` and `/home/<user>` replaced with `[USER]` | VERIFIED |
| **Local File Paths** | Local destination paths, folder names | Absolute Windows disk paths (`C:\...\file.ext`) replaced with `[REDACTED_PATH]` | VERIFIED |
| **Download Filenames** | Logged file names, media names | Quoted filenames with common media/archive/binary extensions (`.iso`, `.exe`, `.zip`, `.pdf`, etc.) replaced with `"[REDACTED_FILENAME]"` | VERIFIED |
| **Tokens & Secrets** | Bearer tokens, API keys, passwords | Header patterns (`Authorization: Bearer ...`) and key-value pairs (`token=...`, `apiKey=...`, `password=...`) replaced with `[REDACTED_TOKEN]` / `[REDACTED_SECRET]` | VERIFIED |
| **Cookies** | Session cookies, `Set-Cookie` headers | `Set-Cookie` and `Cookie` headers scrubbed -> `Cookie: [REDACTED_COOKIE]`; lookaheads prevent redundant double-redaction | VERIFIED |
| **Database & Segment Chunks** | Raw SQLite databases, `.barq-part` chunks | Explicitly excluded from diagnostic payloads; never bundled into export packages | VERIFIED |

---

### 2. Allowlist Architecture & Opt-In Diagnostics Policy

1. **Strict Allowlist Generation:** Diagnostic payloads are generated strictly via explicit property allowlists in `DiagnosticCollector.js`:
   - `system`: `osType`, `platform`, `release`, `arch`, `totalMemoryMB`, `freeMemoryMB`, `cpuCount`, `systemUptimeHours`.
   - `runtime`: `barqVersion`, `electronVersion`, `nodeVersion`, `chromeVersion`, `v8Version`, `schemaVersion`.
   - `telemetry`: sanitized download count aggregates (`totalDownloads`, `activeTransfers`, `queued`, `paused`, `completed`, `failed`, `overallSpeedBps`).
   - `recentLogs`: sanitized event log entries (`id`, `level`, `type`, `message`, `created_at`).
2. **CPU Model String Removal:** The exact CPU model string (`cpuModel`, e.g. `12th Gen Intel(R) Core(TM) i7-12700H`) has been permanently removed from system info exports. Only the generic core count (`cpuCount`) and architecture (`arch`) are retained for scheduler threading verification.
3. **Opt-In by Default:** The "Include System Diagnostics & Recent Logs" checkbox in the Feedback UI (`src/renderer/js/views/feedback.js`) is initialized to `checked: false` by default. Diagnostic attachment is strictly opt-in.
4. **Independent Bug Submission:** Bug reports are fully saveable and exportable without diagnostic attachments (`diagnostic_included: 0`).

---

### 3. Zero-Telemetry Verification

A complete repository audit confirmed that BARQ Downloader contains **zero background telemetry, analytics, or tracking**:
- **No Analytics SDKs:** No Google Analytics, Segment, Mixpanel, Sentry, Bugsnag, or telemetry libraries exist in `package.json` or source files.
- **No Background Update Checks:** No auto-updater or background ping requests are executed.
- **No Automatic Crash Reporting:** No crash reporter SDKs or automated dump uploaders.
- **No Background WebSockets:** No background socket connections.
- **Legitimate Outbound Traffic:** The only outbound network requests permitted in BARQ Downloader are user-initiated file downloads and HTTP probes initiated through `HttpClient.js` (`src/main/engine/HttpClient.js`). All downloads are strictly controlled by user actions.

---

### 4. ZIP Archive Integrity & Boundary Controls

The diagnostic packaging engine in `src/main/diagnostics/ZipExporter.js` utilizes pure Node.js streams and `node:zlib` to produce PKZIP 2.0 compliant ZIP archives:
- **CRC-32 Verification:** Bit-accurate CRC-32 computed for every file entry.
- **UTF-8 Filenames:** PKZIP Bit 11 (Language encoding flag) enabled for all file headers.
- **Duplicate Filename Rejection:** The exporter tracks filenames in a Set and throws an error if duplicate filenames are supplied.
- **Malformed Input Validation:** Rejects `null`, `undefined`, non-object, and empty filename entries.
- **PKZIP 2.0 Limits Enforced:** Enforces maximum 65,535 file entries and maximum 4 GB total / individual file sizes. ZIP64 is documented and rejected as unsupported for lightweight diagnostic bundles.
- **Atomic File Writing & Cleanup:** Exports write first to `.tmp-<timestamp>` staging files. If writing or renaming fails (e.g. disk full, permission denied, collision), a `try ... finally` block guarantees immediate deletion of the incomplete temporary file.

---

### 5. Database Schema Review & Migration v5

In Milestone 7, `exported` was erroneously recorded as a report lifecycle status rather than an action. This caused exported reports to lose their semantic state (whether they were a draft, saved report, or ready report).

**Migration v5 (`feedback_lifecycle_refinement`):**
1. Added column: `is_exported INTEGER NOT NULL DEFAULT 0 CHECK (is_exported IN (0, 1))`.
2. Created index: `idx_feedback_exported ON feedback_reports(is_exported)`.
3. Migrated legacy records: `UPDATE feedback_reports SET is_exported = 1, status = 'saved' WHERE status = 'exported'`.
4. Refined `VALID_STATUSES` to: `['draft', 'saved', 'ready']`.
5. Updated `markExported(id)`: Sets `is_exported = 1` and `exported_at = Date.now()` while preserving the existing lifecycle status (`saved` or `ready`).
6. UI Table Rendering: Displays both the lifecycle status badge (`draft`, `saved`, `ready`) and a separate `Exported` pill.

---

### 6. Content Security Policy (CSP) Compliance Fix

**Issue Identified:**
During manual testing, navigating to the "Settings" view triggered two UI error toasts:
> `⚠️ Inline style attributes are blocked by CSP; use classes.`
This prevented the settings controls from rendering.

**Root Cause:**
`src/renderer/js/views/settings.js` line 237 contained an inline style attribute:
```javascript
h('div', { style: 'display: flex; gap: 8px; margin-top: 4px; font-size: 11px;' }, ...)
```
BARQ's strict Content Security Policy (`style-src 'self'`) disallows inline `style="..."` attributes. The safe DOM constructor `h()` in `src/renderer/js/dom.js` correctly enforces this by throwing an exception when `style` is passed as an attribute.

A similar pattern was discovered in `src/renderer/js/views/downloads.js` lines 162-173 inside the multi-segment modal dialog.

**Resolution:**
1. Created dedicated CSS utility classes in `src/renderer/styles/app.css`:
   - `.setting-badges`: flex container with 8px gap and 11px font.
   - `.segment-row`: segment list item margin.
   - `.segment-row-header`: flex space-between container.
   - `.segment-list`: scrollable max-height container.
   - `.badge-ok` & `.badge-muted`: theme-aware status badges.
2. Refactored `settings.js` to use `class: 'setting-badges'`.
3. Refactored `downloads.js` to use CSS classes and CSSOM property assignment (`fill.style.width = ...`), which is CSP-compliant.
4. Verified that zero inline `style:` attributes exist across the renderer codebase.

---

### 7. Verification Summary

| Verification Step | Target | Result | Evidence |
| :--- | :--- | :--- | :--- |
| **Syntax Audit** | All 65 JS source files | PASSED (0 errors) | `npm run syntax` |
| **Milestone 7.1 Feedback Suite** | Privacy, Redaction, ZIP limits, Migration v5 | PASSED (21/21) | `tests/milestone7-feedback.test.js` |
| **Full Regression Test Suite** | 11 test suites (DB, Engine, M3, M4, M5, M6, M7) | PASSED (153/153) | `npm test` |
| **Electron Runtime Smoke Test** | CSP, Context Isolation, Ready Marker, 11 Views | PASSED (All views render) | `npm run smoke` |
