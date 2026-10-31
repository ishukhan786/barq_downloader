# BARQ DOWNLOADER — MILESTONE 6 IMPLEMENTATION REPORT
## Windows Installer & Release Engineering

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Project Directory:** `D:\Projects\BARQ_DOWNLOADER\`  
**Target Platform:** Windows 10/11 x64  
**Current Version:** 0.1.0  
**Milestone:** 6 — Windows Installer & Release Engineering  
**Date:** October 31, 2026  
**Status:** COMPLETE & VERIFIED

---

## 1. EXECUTIVE SUMMARY

Milestone 6 establishes professional Windows packaging, release distribution, user data preservation, and upgrade reliability for BARQ Downloader.

The packaging pipeline was implemented without altering the core download engine, SQLite architecture, modern dashboard UI, or Chrome/Edge browser extension.

### Core Deliverables Achieved
1. **Windows x64 NSIS Installer:** Created `dist/BARQ-Downloader-Setup-0.1.0.exe` (121.5 MB) providing full desktop shortcuts, Start Menu integration, installation directory selection, and a clean Windows uninstaller.
2. **Single-File Portable Build:** Created `dist/BARQ-Downloader-Portable-0.1.0.exe` (110.5 MB) enabling zero-installation portable execution with local `portable-data/` storage.
3. **Guaranteed User Data Preservation:** Enforced strict separation between read-only application binaries and user data. Upgrades and uninstalls never touch user downloads or the SQLite database.
4. **Packaged Native Messaging Host:** Engineered `barq-native-host.bat` to detect packaged Electron binaries and execute with `ELECTRON_RUN_AS_NODE=1`, eliminating external Node.js runtime dependencies for the browser extension.
5. **Authenticode Signing Architecture:** Audited Windows code-signing requirements, verified development unsigned status (`NotSigned`), and established an Authenticode signing workflow without committing private keys.
6. **Release Checksums:** Generated authoritative SHA-256 checksums in `dist/SHA256SUMS.txt`.

---

## 2. PACKAGING TOOL EVALUATION & SELECTION

| Tool | Evaluated Attributes | Selected? | Rationale |
| :--- | :--- | :---: | :--- |
| **electron-builder (v26.18.0)** | Built-in NSIS compiler, portable target, ASAR unpacking, Authenticode signing, Windows icon bundling, zero external native toolchain dependencies. | **YES** | Industry standard for production Windows Electron applications. Direct support for custom NSIS installation paths, Start Menu/Desktop shortcuts, and differential block maps. |
| **@electron/packager** | Low-level archive packaging only. Requires manual WiX/InnoSetup script generation. | No | Lacks integrated NSIS installer generation and portable packaging. |
| **electron-winstaller (Squirrel.Windows)** | Fixed installation directory (`AppData`), no directory selection wizard, silent background installs. | No | Violates Milestone 6 requirement for user-selectable installation directories and explicit desktop shortcuts. |

---

## 3. CONFIGURATION & ARCHITECTURAL IMPLEMENTATION

### 3.1 `electron-builder.json` Specification
The packaging configuration was codified in [`electron-builder.json`](file:///D:/Projects/BARQ_DOWNLOADER/electron-builder.json):
- **Application ID:** `com.barq.downloader`
- **Product Name:** `BARQ Downloader`
- **Publisher:** `BARQ` (derived from `"author": "BARQ"` in `package.json`)
- **Version:** `0.1.0`
- **Icon:** `assets/icons/barq.ico` (multi-resolution 16x16 to 256x256 embedded ICO)
- **File Inclusions:**
  - `src/**/*`
  - `assets/icons/**/*`
  - `native-host/**/*`
  - `browser-extension/**/*`
  - `package.json`
- **ASAR & Unpacked Assets:**
  - `asar: true` for tamper-resistant source packaging.
  - `asarUnpack: ["native-host/**/*"]`: Extracts the Native Messaging Host batch scripts and Node relay scripts into `resources/app.asar.unpacked/native-host/` so Windows `cmd.exe` and browser hosts can execute them directly.
- **Extra Resources:**
  - `extraResources: [{ "from": "browser-extension", "to": "browser-extension" }]`: Deploys the unpacked Chrome/Edge extension files to `<install-dir>/resources/browser-extension/` for one-click browser loading.

### 3.2 NSIS Installer Configuration
- **oneClick: false:** Displays the standard installation wizard.
- **perMachine: false:** Installs into user's local application folder (`%LOCALAPPDATA%\Programs\BARQ Downloader`) by default without triggering UAC elevation prompts, while supporting custom folder selection (including `C:\Program Files`).
- **allowToChangeInstallationDirectory: true:** Allows users to choose any custom drive or path.
- **createDesktopShortcut: "always":** Creates a desktop shortcut with the official BARQ lightning icon.
- **createStartMenuShortcut: true:** Creates a Start Menu shortcut under `BARQ Downloader`.
- **deleteAppDataOnUninstall: false:** **CRITICAL SAFETY CONTROL:** Uninstallation explicitly preserves the user's SQLite database (`barq.db`), settings, and downloaded files.

### 3.3 Portable Build Configuration
- Target: `portable`
- Executable Name: `BARQ-Downloader-Portable-0.1.0.exe`
- When placed in a directory with a writable folder, or when beside a `portable-data/` folder, [`src/main/paths.js`](file:///D:/Projects/BARQ_DOWNLOADER/src/main/paths.js) stores all SQLite data, temp files, and logs inside `portable-data/`, leaving the host system registry and `%APPDATA%` clean.

### 3.4 Packaged Browser Extension Integration
In [`native-host/barq-native-host.bat`](file:///D:/Projects/BARQ_DOWNLOADER/native-host/barq-native-host.bat):
```bat
@echo off
setlocal
set "HOST_DIR=%~dp0"

:: 1. If running inside a packaged app, prefer the bundled Electron executable as Node runtime
if exist "%HOST_DIR%..\..\BARQ Downloader.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HOST_DIR%..\..\BARQ Downloader.exe" "%HOST_DIR%barq-native-host.js" %*
  exit /b %ERRORLEVEL%
)

if exist "%HOST_DIR%..\BARQ Downloader.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HOST_DIR%..\BARQ Downloader.exe" "%HOST_DIR%barq-native-host.js" %*
  exit /b %ERRORLEVEL%
)

:: 2. Fallback to system node
node "%HOST_DIR%barq-native-host.js" %*
exit /b %ERRORLEVEL%
```
- In packaged builds, Chrome/Edge launches `barq-native-host.bat`, which invokes the bundled `BARQ Downloader.exe` with `ELECTRON_RUN_AS_NODE=1`.
- The user **does not need Node.js installed** on their Windows computer to use the browser extension.

In [`native-host/registry-manager.js`](file:///D:/Projects/BARQ_DOWNLOADER/native-host/registry-manager.js):
- Dynamic path redirection automatically replaces `app.asar` with `app.asar.unpacked`, ensuring Windows Registry entries (`HKCU\Software\Google\Chrome\NativeMessagingHosts\com.barq.downloader`) point to the physically accessible batch file.

---

## 4. RELEASE ARTIFACTS & CHECKSUMS

Generated in `dist/`:

| Artifact | File Name | Size (Bytes) | SHA-256 Checksum |
| :--- | :--- | :---: | :--- |
| **Windows x64 NSIS Installer** | `BARQ-Downloader-Setup-0.1.0.exe` | 121,531,260 | `1015B1DC6CB38EE21D0F12C2BA02F7DEF929C61BE5316958607B3253EC9173FA` |
| **Windows x64 Portable Executable** | `BARQ-Downloader-Portable-0.1.0.exe` | 110,495,212 | `B7385EBF509BF46F3F49E3AA97E2153117969F8950F20F80B5EBD993A4EE10DA` |
| **Differential Update Block Map** | `BARQ-Downloader-Setup-0.1.0.exe.blockmap` | 127,356 | `3970EFA34B41920D235FBC7BE3E67F6D43B069D1E4EBEED48512134261B6DE4D` |
| **Checksum Manifest** | `SHA256SUMS.txt` | 178 | Verified matching against generated binaries |

---

## 5. USER DATA PRESERVATION & UPGRADE SAFETY

### Data Storage Architecture
- **Installed Mode:**
  - Binary Folder: `%LOCALAPPDATA%\Programs\BARQ Downloader\` (or custom user directory)
  - User Data Folder: `%LOCALAPPDATA%\BARQ Downloader\`
  - Database: `%LOCALAPPDATA%\BARQ Downloader\barq.db`
  - Logs: `%LOCALAPPDATA%\BARQ Downloader\logs\`
  - Downloads: `C:\Users\<user>\Downloads\BARQ\` (or custom user destination)
- **Upgrade Invariant:** When a new build installs over an existing build:
  1. Installer replaces files only inside the application installation directory.
  2. `%LOCALAPPDATA%\BARQ Downloader\barq.db` is never overwritten.
  3. On startup, `BarqDatabase.open()` checks `user_version` and executes incremental migrations (`schema_migrations`) non-destructively.
  4. Completed download records and in-progress downloads persist cleanly.
- **Uninstall Invariant:**
  - The uninstaller deletes only installed application binaries and shortcuts.
  - User download files and database history remain completely intact.

---

## 6. VERIFICATION COMMANDS

```powershell
# 1. Package the unpacked application directory
npm run pack

# 2. Compile full NSIS installer and portable executable
npm run dist

# 3. Verify release artifacts and checksums
Get-FileHash dist/BARQ-Downloader-Setup-0.1.0.exe, dist/BARQ-Downloader-Portable-0.1.0.exe -Algorithm SHA256

# 4. Run dedicated Milestone 6 installer verification suite
node --test tests/milestone6-installer.test.js
# Output: tests 8, pass 8, fail 0 (duration: ~14.1s)

# 5. Run complete regression test suite
npm test
# Output: tests 132, pass 132, fail 0 (duration: ~63.1s)
```
