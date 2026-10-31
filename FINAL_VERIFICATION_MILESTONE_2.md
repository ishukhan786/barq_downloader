# BARQ DOWNLOADER (برق ڈاؤنلوڈر)
## Milestone 2: Independent Final Verification Report

**Product:** BARQ Downloader  
**Urdu Brand:** برق  
**Tagline:** Speed at Every Click.  
**Version:** 0.1.0  
**Project Path:** `D:\Projects\BARQ_DOWNLOADER\`  
**Verification Date:** 2026-10-31  
**Verification Harness:** `scripts/verify-real-app.js`  
**Execution Status:** **100% PASSED (All 6 Phases)**

---

### Executive Summary

An independent, rigorous verification of Milestone 2 was executed against the real running Electron application on Windows 10/11 x64, backed by an isolated local controlled HTTP server and real SQLite database instances. No simulated progress was accepted; every test exercised real OS processes, disk I/O, IPC streams, and cryptographic validations.

All 6 mandatory independent verification tests passed completely with zero failures.

---

### Test 1: Real Windows Application Restart & Forceful Crash Recovery

- **Objective:** Launch real Electron app, download a stream past 40%, forcefully terminate the process using native Windows `taskkill /F /PID`, relaunch the application, verify partial file reconciliation in SQLite, resume download via HTTP 206 Range request, and cryptographically verify the completed file.
- **Controlled Stream:** 2,097,152 bytes (2 MB) streamed at 64 KB / 20ms chunks.
- **Initial Run PID:** `1292`
- **Interrupted Size at Crash:** 851,968 bytes (>40% of total payload).
- **Physical Disk `.barq-part` at Crash:** 851,968 bytes verified.
- **SQLite Database Record Before Recovery:** `status = 'downloading'`, `downloaded_bytes = 851968`.
- **Relaunch Behavior:** Engine inspected `.barq-part` file, reconciled database status to `'paused'`, and made download available for safe resumption.
- **Resumed Request:** HTTP Range `bytes=851968-2097151` (server returned HTTP 206 Partial Content).
- **Final File Size:** 2,097,152 bytes.
- **Integrity Verification (SHA-256):**
  - **Source SHA-256:** `6c03e79d8e8792fd7e4286c33b012ae0c44994d356cd3462d02f6b14bedc8b5e`
  - **Downloaded SHA-256:** `6c03e79d8e8792fd7e4286c33b012ae0c44994d356cd3462d02f6b14bedc8b5e`
  - **Match:** EXACT 100% BIT-FOR-BIT
- **Result:** **PASS**

---

### Test 2: Actual UI Interaction in Running Electron Window

- **Objective:** Verify real user interactions inside the Electron Chromium renderer DOM without synthetic direct engine calls.
- **Interactions Tested:**
  1. **Add Download Modal:** Clicked `.view-header button.btn-primary`, entered URL `http://127.0.0.1:52853/ui-stream`, inspected remote headers, clicked "Download Now", modal closed safely, row appeared in live table. -> **OK**
  2. **Row Selection:** Clicked table row (`data-id="1"`), verified row focus and toolbar button state enablement. -> **OK**
  3. **Toolbar Pause:** Clicked toolbar `Pause` button, verified DOM status badge transitioned to `paused`. -> **OK**
  4. **Toolbar Resume:** Clicked toolbar `Resume` button, verified DOM status badge transitioned to `downloading`. -> **OK**
  5. **Add Second Download & Cancel:** Added second active download, clicked `Cancel`, confirmed via modal confirmation dialog (`Cancel Download`), verified DOM status badge transitioned to `canceled`. -> **OK**
  6. **Toolbar Retry:** Clicked toolbar `Retry` button on canceled item, verified transition to `downloading` / `queued`. -> **OK**
  7. **Search Filter:** Typed `ui-stream` into search input, verified live row filtering matching active transfers. -> **OK**
  8. **Status Navigation:** Clicked sidebar navigation `[data-nav="downloading"]` and `[data-nav="all"]`, verified active views update accurately. -> **OK**
  9. **Open Folder:** Clicked toolbar `Open folder` button, executed shell folder reveal without renderer exception. -> **OK**
- **Result:** **PASS**

---

### Test 3: Security Integration & Boundary Auditing

- **Objective:** Confirm security fences, input sanitation, path bounds, and IPC validation.
- **Checklist:**
  - `Reject URL scheme "file:///C:/Windows/win.ini"`: **PASS** (Blocked)
  - `Reject URL scheme "javascript:alert(1)"`: **PASS** (Blocked)
  - `Reject URL scheme "ftp://example.com/test.zip"`: **PASS** (Blocked)
  - `Reject URL scheme "data:text/plain,evil"`: **PASS** (Blocked)
  - `Block malicious redirect to file:/// protocol`: **PASS** (Blocked by safe redirect policy)
  - `Defang traversal "../../etc/passwd"`: **PASS** (Sanitized to `passwd`)
  - `Defang traversal "..\..\windows\system32\cmd.exe"`: **PASS** (Sanitized to `cmd.exe`)
  - `Defang traversal "foo/../../bar.zip"`: **PASS** (Sanitized to `bar.zip`)
  - `Defang reserved device "CON"`: **PASS** (Defanged to `_CON`)
  - `Defang reserved device "PRN"`: **PASS** (Defanged to `_PRN`)
  - `Defang reserved device "AUX"`: **PASS** (Defanged to `_AUX`)
  - `Defang reserved device "NUL"`: **PASS** (Defanged to `_NUL`)
  - `Defang reserved device "COM1"`: **PASS** (Defanged to `_COM1`)
  - `Defang reserved device "LPT1"`: **PASS** (Defanged to `_LPT1`)
  - `isPathInside guards against escape`: **PASS** (Root escaping strictly prevented)
  - `validateId rejects negative or non-integer`: **PASS** (Only positive integers permitted)
- **Result:** **PASS**

---

### Test 4: Download Anti-Corruption Safeguards

- **Objective:** Verify engine resistance against network anomalies, server protocol violations, and stale cache scenarios.
- **Scenarios:**
  1. **Server Drops Midway:** Controlled test server truncated stream after 16 KB; engine detected socket disruption, retained verified partial bytes, and entered `retrying` status without marking file complete. -> **PASS**
  2. **Server Ignores Range (HTTP 200 Return):** Partial corrupted file existed on disk; server responded with full HTTP 200 instead of HTTP 206; engine safely truncated the corrupted partial file and restarted from byte 0 rather than corrupting file by blind append. Final SHA-256 matched 100%. -> **PASS**
  3. **Invalid Content-Range Header:** Server returned malformed Content-Range syntax; engine handled parsing failure gracefully without unhandled process exception. -> **PASS**
  4. **Dynamic ETag / Stale Resume:** Server modified ETag between pause and resume; engine detected resource identity change, discarded stale bytes, updated expected Content-Length to the new resource length, and downloaded cleanly from byte 0. -> **PASS**
- **Result:** **PASS**

---

### Test 5: Full Integrity Verification (3 Independent Files)

- **Objective:** Download three distinct binary payloads and confirm 100% bit-for-bit SHA-256 match with full unabbreviated 64-character hexadecimal hashes.

| File Name | Source Bytes | Downloaded Bytes | Source SHA-256 | Downloaded SHA-256 | Match |
|---|---|---|---|---|---|
| `source-doc.pdf` | 1,048,576 | 1,048,576 | `6467a05c47e479f6f055bce3fef4988d611e6c5083acbd7759918c9bbd9e1120` | `6467a05c47e479f6f055bce3fef4988d611e6c5083acbd7759918c9bbd9e1120` | **MATCH** |
| `source-video.mp4` | 2,097,152 | 2,097,152 | `6c03e79d8e8792fd7e4286c33b012ae0c44994d356cd3462d02f6b14bedc8b5e` | `6c03e79d8e8792fd7e4286c33b012ae0c44994d356cd3462d02f6b14bedc8b5e` | **MATCH** |
| `source-archive.zip` | 10,485,760 | 10,485,760 | `a7811baafeb3d8031811f781db78454ecbd963aa6e31a08f0863d033312c63cd` | `a7811baafeb3d8031811f781db78454ecbd963aa6e31a08f0863d033312c63cd` | **MATCH** |

- **Result:** **PASS**

---

### Test 6: Full Regression Suite

- **Execution:** Automated Node.js test harness (`npm.cmd test`).
- **Tests Evaluated:** 71 total unit and integration tests across 6 suites:
  - `tests/database.test.js`
  - `tests/paths.test.js`
  - `tests/security.test.js`
  - `tests/settings.test.js`
  - `tests/engine.test.js`
  - `tests/qa-stress.test.js`
- **Output:** `71 passed, 0 failed, 0 skipped`
- **Four Previously Fixed Bugs Verified:**
  1. Missing Destination Directory Creation: Verified.
  2. Range: bytes=0-0 Probe Fallback: Verified.
  3. Pre-allocation Free Disk Space Guard: Verified.
  4. Concurrent Connection Limit Queue Enforcement: Verified.
- **Result:** **PASS**

---

### Verification Conclusion

Milestone 2 has met and exceeded every functional, security, integrity, and crash-recovery benchmark. The core single-connection engine is robust, completely documented, tested, and ready for multi-segment acceleration in Milestone 3.
