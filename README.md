# BARQ Downloader (برق ڈاؤنلوڈر)

> **Speed at Every Click.**

BARQ Downloader is a free, modern, and secure Windows desktop download manager built from scratch with Electron, Node.js, and SQLite.

---

## Brand Identity

- **Official Name:** BARQ Downloader
- **Brand:** BARQ
- **Urdu Brand Name:** برق
- **Tagline:** Speed at Every Click.
- **Identifier:** `com.barq.downloader`
- **Visual Direction:** Premium professional software aesthetic with graphite black backgrounds (`#0d0f12`), electric emerald green accents (`#00e09a`), crisp white and muted slate typography, and a custom geometric lightning mark.

---

## Architecture & Security Model

BARQ is engineered with a strict multi-process isolation and defense-in-depth model:

1. **Privileged Scheme & Origin Isolation:**
   - Renderer assets are served via a custom scheme `barq://app/` (with strict 404 traversal guards).
   - Network requests (`http`, `https`, `ws`, `wss`) from the renderer process are blocked at the session level. All network activity is handled exclusively by the Node.js download engine in the main process.

2. **Hardened Preload & Context Isolation:**
   - `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
   - The preload script exposes a narrow, frozen API (`window.barq`) via `contextBridge`. Raw `ipcRenderer`, filesystem, or Node modules are never exposed to the page.

3. **Content Security Policy (CSP):**
   - Strictly enforced via HTTP response headers and `<meta>` tags:
     `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`

4. **Input & Path Validation:**
   - URL validation: accepts only clean `http:` and `https:` schemes. Rejects embedded credentials, control characters, and protocols like `file:`, `javascript:`, and `data:`.
   - Safe path resolution and Windows reserved filename sanitization (`CON`, `PRN`, `AUX`, `NUL`, etc.).
   - IPC sender verification: validates that incoming messages originate strictly from the top frame of `barq://app`.

5. **Storage & Portability:**
   - Portable mode: when packaged and placed beside a writable `portable-data/` folder, all databases, profiles, logs, and caches stay local to that directory.
   - Per-user fallback: automatically falls back to `%LOCALAPPDATA%\BARQ Downloader` if running in read-only locations.
   - SQLite with WAL mode, foreign keys, versioned migrations, and automated corruption quarantine.

---

## Project Structure

```
BARQ_DOWNLOADER/
├── assets/
│   └── icons/                 # Multi-res icons: 16px to 512px + barq.ico
├── src/
│   ├── main/                  # Electron main process
│   │   ├── app-protocol.js    # Privileged barq:// scheme & traversal defense
│   │   ├── ipc.js             # Validated IPC handlers
│   │   ├── logger.js          # Redacting file and console logger
│   │   ├── main.js            # Main lifecycle & window coordinator
│   │   ├── paths.js           # Portable data & directory resolution
│   │   ├── security.js        # URL, path, and IPC sender validators
│   │   ├── settings-schema.js # Declarative settings validation schema
│   │   ├── windows.js         # Main window and splash screen
│   │   └── db/                # SQLite storage engine
│   │       ├── database.js    # Connection, WAL, backup & restore
│   │       ├── downloads-repo.js # Downloads & events repository
│   │       ├── migrations.js  # Versioned append-only migrations
│   │       └── settings-repo.js # Settings repository
│   ├── preload/
│   │   └── preload.js         # Sandboxed contextBridge API (window.barq)
│   ├── renderer/              # Frontend UI (Vanilla JS + CSS)
│   │   ├── index.html         # Main application shell
│   │   ├── splash.html        # Native splash window
│   │   ├── assets/brand/      # SVG brand marks and logos
│   │   ├── styles/            # CSS design system (Dark & Light themes)
│   │   └── js/                # Modular client controllers
│   └── shared/                # Shared constants (brand, categories)
├── tests/                     # Automated unit and integration tests
├── scripts/                   # Verification, icon generation, and smoke tests
└── package.json
```

---

## Verification & Testing

Run all syntax checks and automated unit tests:

```powershell
npm run syntax
npm test
npm run smoke
```

Or run the complete verification suite in one step:

```powershell
npm run check
```

---

## Development Milestones

- [x] **Milestone 1:** Project scaffold, BARQ visual identity, Electron foundation, secure preload, SQLite database, basic navigation, and portable data paths.
- [ ] **Milestone 2:** Direct download engine, live progress, pause/resume, cancel, retry, SQLite persistence, and restart recovery.
- [ ] **Milestone 3:** Multi-segment engine, Range validation, safe chunk merging, and SHA-256 verification.
- [ ] **Milestone 4:** Chrome and Microsoft Edge browser extensions with authenticated local bridge.
- [ ] **Milestone 5:** Optional video downloader with yt-dlp and FFmpeg integration.
- [ ] **Milestone 6:** Windows x64 portable package, performance benchmarking, security audit, and final release.
