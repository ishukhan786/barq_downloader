# BARQ Downloader — Privacy & Telemetry Policy
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Version:** 0.1.0  
**Effective Date:** 2026-10-31  

---

## 1. Core Commitment: Zero Automatic Telemetry

BARQ Downloader is designed and engineered under a strict **Zero Telemetry by Default** architecture.

Unlike commercial download managers that bundle silent analytics, heartbeat beacons, device fingerprinting, or browsing telemetry SDKs, BARQ Downloader contains:
- **Zero background telemetry**
- **Zero periodic heartbeat pings**
- **Zero third-party analytics SDKs**
- **Zero automatic crash upload daemons**
- **Zero advertising tracking networks**

Your downloads, URLs, filenames, directory structures, and system identities remain strictly confidential and confined to your local computer.

---

## 2. Local-Only Feedback Storage

When you log a bug report or suggest a feature inside the BARQ application:
- All report titles, descriptions, categories, severities, and reproduction steps are committed directly to your private, local SQLite database (`barq.db`).
- Reports are given a local unique identifier (e.g. `BARQ-A1B2C3`).
- No data is transmitted across the internet upon saving, modifying, or deleting reports.
- You have unrestricted rights to edit, export, or permanently delete any feedback record at any time.

---

## 3. Strict Diagnostic Allowlist & Sanitization

When you choose to include system diagnostics or export a diagnostic bundle, the application runs our automated, privacy-first **Diagnostic Collector & Sanitizer**.

The diagnostic collector utilizes a **strict allowlist**, never an ad-hoc dump:

### What Is Included (Strict Allowlist):
1. **Operating System Platform:** Windows OS release, build architecture (x64), and total/free physical memory (MB).
2. **CPU Metrics:** Core count and processor family name.
3. **Runtime Versions:** BARQ version, Electron runtime version, Node.js version, and SQLite schema migration version.
4. **Aggregate Telemetry Totals:** Numeric counts only (total downloads recorded, completed count, active transfer count, paused count, failed count, current aggregate download speed).
5. **Scrubbed Error Logs:** Up to 50 recent diagnostic log lines from the local `events` table with comprehensive sanitization.

### What Is Never Included (Strict Exclusion Guarantee):
- **NO Credentials:** Passwords, authentication headers, cookies, API keys, or access tokens are strictly stripped and replaced with `[REDACTED_SECRET]` or `[REDACTED_TOKEN]`.
- **NO Download URLs:** All HTTP/HTTPS URLs and query parameters are replaced with `[REDACTED_URL]`.
- **NO Local Windows Usernames:** Your Windows user folder and username (e.g., `C:\Users\<username>\...`) are scrubbed and replaced with `C:\Users\[USER]\...`.
- **NO Complete File Paths:** Filenames and local directory paths are scrubbed.
- **NO SQLite Database Files:** The `barq.db` database, WAL files, and recovery files are never included in exports.
- **NO Download Chunks or Payloads:** `.barq-part` temporary files and completed download data are never read or bundled.
- **NO IP Addresses:** External IPv4 and IPv6 network addresses are replaced with `[REDACTED_IP]`.

---

## 4. Transparent Inspection Before Export

You are always in complete control. Before exporting diagnostic data:
1. You can click **"Preview Diagnostics"** in the **Feedback & Support** dashboard.
2. The entire payload is rendered in an accessible, interactive JSON viewer.
3. You can review the exact text, copy it to your clipboard, or reject the export entirely.
4. Exporting generates a standard ZIP package (`BARQ-Diagnostics-YYYY-MM-DD-HH-mm.zip`) or JSON document (`BARQ-Feedback-BARQ-XXXXXX.json`) saved directly to a folder you select via Windows Explorer.

---

## 5. Security & CSP Enforcement

BARQ's desktop renderer operates in a hardened sandbox:
- **`connect-src 'none'`**: The graphical interface cannot initiate arbitrary background HTTP/HTTPS requests to the web.
- **Context Isolation & Preload Boundary**: Page scripts cannot access Node.js or native filesystem APIs.
- All exports require explicit IPC validation with strict path traversal prevention (`isPathInside` / `safeJoin`).

---

## 6. Questions & Data Ownership

You own all data processed by BARQ Downloader. If you uninstall the application or delete your data folder, all feedback records, download histories, and configuration settings are completely and irreversibly removed from your storage drive.
