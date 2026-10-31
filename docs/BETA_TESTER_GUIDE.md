# BARQ Downloader — Public Beta Tester Guide
**Version:** 0.1.0 (Public Beta)  
**Brand:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Target Platform:** Windows 10/11 x64  
**Date:** November 2026  

---

## 1. Welcome to the BARQ Public Beta

Thank you for participating in the public beta testing program for **BARQ Downloader (برق)**.

BARQ Downloader is a high-performance, privacy-first, secure Windows download manager engineered with multi-segment connection splitting, browser integration, zero telemetry, and cryptographically verified updates.

As a beta tester, your feedback, bug reports, and diagnostic traces directly shape the commercial reliability of our product.

---

## 2. Release Artifacts & Installation

BARQ Downloader provides two official Windows x64 distributions:

### A. Windows Installer (`BARQ-Downloader-Setup-0.1.0.exe`)
- Standard per-user Windows installation (no Administrator rights required).
- Automatically installs to `%LOCALAPPDATA%\Programs\BARQ Downloader`.
- Creates desktop and Start Menu shortcuts.
- Stores database, logs, and downloads safely in `%LOCALAPPDATA%\BARQ Downloader`.
- Supports clean Windows uninstallation via Windows Settings -> Apps -> Installed Apps.

### B. Portable Edition (`BARQ-Downloader-Portable-0.1.0.exe`)
- Fully self-contained single-file executable.
- Run from any USB drive or folder without writing outside its root.
- Stores data and downloads in a local `portable-data/` folder beside the executable.

---

## 3. Release Channels & Update System

BARQ includes a secure, privacy-first update system integrated into **Settings -> Software Updates & Release Channel**.

### Available Channels
1. **Beta Channel (Default):**
   - Receives early public beta releases, new features, and optimization experiments.
   - Recommended for all beta testers.
2. **Stable Channel:**
   - Reserved for production-ready, fully hardened commercial releases.

### Cryptographic Update Verification
BARQ never executes or applies untrusted updates. Every update must satisfy:
- **HTTPS Enforcement:** Update manifests and binary payloads are only fetched over authenticated TLS connections. Insecure HTTP or redirected links are immediately dropped.
- **Ed25519 Digital Signatures:** Release manifests are canonicalized using RFC 8785 and verified against BARQ's embedded root public keys (`trusted-keys.json`).
- **SHA-256 Bit-for-Bit Checksum:** Every downloaded installer is hashed and compared before presentation.
- **Downgrade & Rollback Rejection:** Manifests with version numbers lower than the currently running version are rejected as potential rollback attacks.
- **Explicit User Consent:** Updates are never installed in the background without user permission. You will always be prompted to review and confirm.

---

## 4. How to Submit Feedback & Bug Reports

BARQ Downloader features a built-in, local **Feedback & Support** view accessible directly from the left sidebar.

### Submitting a Bug Report
1. Click **Feedback & Support** in the left navigation sidebar.
2. Select **Report a Bug**.
3. Provide a clear summary title and description of what occurred.
4. (Optional) Check **Attach diagnostic information** to include sanitized system metrics (OS version, Electron runtime, memory statistics).
   > **Privacy Guarantee:** All URLs, personal filenames, user paths (`C:\Users\<username>`), IP addresses, passwords, tokens, and authorization headers are automatically scrubbed locally using an explicit allowlist sanitizer before export.
5. Click **Save Report**.
6. You can review, copy, or export your report as JSON or a `.zip` diagnostic bundle to share with the engineering team.

---

## 5. Safe Database Rollback

In the unlikely event of an unexpected application error during an update:
- BARQ automatically creates a WAL-consistent SQLite snapshot (`.db` and `.meta.json`) using `VACUUM INTO` before applying any database migrations.
- Previous backups are stored safely in `dev-data/backups/` or `%LOCALAPPDATA%\BARQ Downloader\backups/`.
- Refer to `docs/UPDATE_RECOVERY_GUIDE.md` for step-by-step restoration procedures.

---

## 6. Known Beta Behaviors
- **Windows SmartScreen (Unsigned Beta Builds):** In environments where Authenticode code-signing certificates are not configured, Windows SmartScreen may present an informational "Windows protected your PC" banner. Click *More info* -> *Run anyway*.
- **Native Extension Bridge:** Browser extension requires one-time registration by clicking *Settings -> Browser Extensions -> Register Host*.
