# BARQ Downloader — Diagnostics Export Guide
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Document:** Diagnostics Export & Technical Inspection Guide  
**Applies to:** Windows 10/11 x64  

---

## 1. Overview

BARQ Downloader includes a built-in, zero-dependency diagnostic export system. It allows users and beta testers to capture application runtime states, environmental specifications, and sanitized error traces to aid in troubleshooting, without exposing confidential files, passwords, or personal paths.

---

## 2. Export Artifacts

When you trigger an export from **Feedback & Support**, BARQ generates one of two standardized formats:

### A. Full Diagnostic ZIP Archive
- **Default Filename Pattern:** `BARQ-Diagnostics-YYYY-MM-DD-HH-mm.zip` (e.g. `BARQ-Diagnostics-2026-10-31-23-45.zip`)
- **Archive Contents:**
  1. `report.json`: Form-filled report details (report ID, category, severity, reproduction steps, expected vs. actual behavior).
  2. `system-diagnostics.json`: Hardware, operating system, and runtime engine environment.
  3. `sanitized-events.json`: Chronological audit logs from recent application activity, scrubbed of all URLs, personal folder names, and tokens.
  4. `privacy-manifest.txt`: Human-readable statement verifying data inclusions and exclusion guarantees.

### B. Single Standalone JSON Report
- **Default Filename Pattern:** `BARQ-Feedback-BARQ-XXXXXX.json` (e.g. `BARQ-Feedback-BARQ-001A2B.json`)
- **Contents:** Clean, formatted JSON document with the feedback report metadata and optional embedded diagnostics.

---

## 3. How to Export Diagnostics

### Method 1: Exporting Full System Diagnostics (ZIP)
1. Open BARQ Downloader.
2. In the sidebar navigation, click **"Feedback & Support"**.
3. In the upper-right header, click **"Export Diagnostics ZIP"**.
4. A native Windows Save As dialog will appear.
5. Select your desired save location (e.g. `Desktop` or `Downloads`) and click **Save**.
6. A toast notification will confirm: `Exported diagnostic package (XX.X KB)`.

### Method 2: Exporting from an Individual Report
1. Open **Feedback & Support** and switch to the **"My Reports"** tab.
2. Locate the report you wish to export in the reports table.
3. In the row actions column:
   - Click the **Document icon** to export as a `.json` file.
   - Click the **Export box icon** to export as a `.zip` archive with full diagnostics attached.
4. Select your destination and click **Save**.

### Method 3: Reviewing Before Exporting (Preview Modal)
1. In **Feedback & Support**, click **"Preview Diagnostics"**.
2. An interactive window displays the exact JSON payload.
3. Click **"Copy to Clipboard"** if you want to paste the data into a technical forum or direct message.
4. Click **"Export JSON"** to save directly to disk.

---

## 4. Understanding Diagnostic Data Fields

### `system` Object
```json
{
  "osType": "Windows_NT",
  "platform": "win32",
  "release": "10.0.26100",
  "arch": "x64",
  "totalMemoryMB": 16384,
  "freeMemoryMB": 6842,
  "cpuModel": "Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz",
  "cpuCount": 12,
  "systemUptimeHours": 14.25
}
```
*Purpose:* Identifies whether the machine is running Windows 10 or 11, available RAM, and CPU threading capacity for parallel segment downloading.

### `runtime` Object
```json
{
  "barqVersion": "0.1.0",
  "electronVersion": "45.2.1",
  "nodeVersion": "22.13.0",
  "chromeVersion": "130.0.6723.44",
  "v8Version": "13.0.245.12",
  "schemaVersion": 4
}
```
*Purpose:* Verifies the application version, internal Node/Electron engine version, and database migration state.

### `telemetry` Summary Object
```json
{
  "totalDownloads": 14,
  "activeTransfers": 2,
  "queued": 0,
  "paused": 1,
  "completed": 10,
  "failed": 1,
  "overallSpeedBps": 12582912
}
```
*Purpose:* Provides high-level operational counts without revealing what is being downloaded.

### `recentLogs` Array
```json
[
  {
    "id": 142,
    "level": "error",
    "type": "download-failed",
    "message": "Connection to [REDACTED_URL] failed with status 403 Forbidden",
    "created_at": 1793478900000
  }
]
```
*Purpose:* Tracks recent error codes and engine events with automatic regex scrubbing of URLs, IP addresses, Windows user profile paths, and authorization tokens.

---

## 5. Security & Technical Architecture

- **Zero External Dependencies:** ZIP file packaging is executed entirely through Node.js built-in `zlib.deflateRawSync` and standard PKZIP binary record structures. No untrusted third-party npm libraries are utilized.
- **Atomic File Writing:** All exports write to a temporary file (`${destPath}.tmp-${Date.now()}`) before atomic rename, ensuring zero partial or corrupted output files.
- **Path Traversal Protection:** User-chosen paths are validated with `isPathInside` and strict OS file dialogs, preventing arbitrary disk escape.
