# BARQ DOWNLOADER — MILESTONE 5 SECURITY AUDIT
## Comprehensive Security, IPC Isolation & Vulnerability Assessment

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Tagline:** Speed at Every Click.  
**Project Directory:** `D:\Projects\BARQ_DOWNLOADER\`  
**Target Platform:** Windows 10/11 x64  
**Date:** October 31, 2026  
**Audit Status:** PASSED (Zero High/Critical Vulnerabilities)

---

## 1. EXECUTIVE SUMMARY

An extensive security and threat modeling audit was conducted across BARQ Downloader as part of Milestone 5 production hardening. The audit examined all trust boundaries:
1. **Renderer Process <-> Preload Script <-> Electron Main Process**
2. **Browser Extension (Chrome/Edge) <-> Native Messaging Host <-> Named Pipe Server**
3. **Remote HTTP/HTTPS Servers <-> Download Engine <-> Local File System**
4. **SQLite Persistence Layer <-> Data Storage**

### Key Findings
- **Zero Critical / High Security Vulnerabilities:** No path traversal, arbitrary code execution, privilege escalation, or unauthorized IPC access vectors were identified.
- **Strict Context Isolation:** Verified that `nodeIntegration = false`, `contextIsolation = true`, and `sandbox = true` are enforced. Global primitives (`require`, `process`, `module`) are completely inaccessible in the renderer context.
- **Content Security Policy (CSP):** Verified that inline scripts, `eval()`, and arbitrary network connections from the renderer are strictly blocked by CSP headers.
- **Defanged File Inputs:** Directory traversal attempts, null-byte injections, and Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`) are sanitized prior to file system operations.
- **Authenticated Local IPC:** Windows Named Pipe communication with the Chrome/Edge extension requires a 256-bit cryptographically secure token stored with restricted user permissions.

---

## 2. ELECTRON PROCESS ISOLATION & CSP

### 2.1 Window Security Configuration
In `src/main/main.js`:
- `nodeIntegration: false` (Renderer cannot execute Node.js APIs directly).
- `contextIsolation: true` (Preload scripts execute in an isolated execution context).
- `sandbox: true` (Renderer runs in Chromium OS-level sandbox).
- `webSecurity: true` (Same-origin policy strictly enforced).
- `allowRunningInsecureContent: false` (Mixed content blocked).

### 2.2 Content Security Policy (CSP)
Enforced in both HTTP headers and HTML metadata:
```http
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
font-src 'self';
connect-src 'none';
frame-src 'none';
object-src 'none';
base-uri 'none';
form-action 'none';
```
- **connect-src 'none':** The renderer cannot make unauthorized background `fetch()`, `XMLHttpRequest`, or `WebSocket` connections to external tracking servers or command-and-control hosts. All network requests are brokered exclusively by the audited Electron main process engine.
- **script-src 'self':** Inline script injection (`<script>alert(1)</script>`) is blocked by Chromium CSP enforcement (`[PASS]` in smoke test).

---

## 3. INPUT VALIDATION & FILE SYSTEM PROTECTION

### 3.1 Filename Sanitization & Windows Reserved Device Names
Untrusted filenames from `Content-Disposition` headers, URL paths, or browser extension messages are sanitized using `sanitizeFilename()` in `src/main/security.js`:

```javascript
// Neutralizes directory traversal
sanitizeFilename('../../etc/passwd')                  => 'passwd'
sanitizeFilename('..\\..\\Windows\\System32\\calc.exe') => 'calc.exe'

// Neutralizes Windows reserved device names (which crash or hang Windows Explorer)
sanitizeFilename('CON')      => '_CON'
sanitizeFilename('prn.txt')  => '_prn.txt'
sanitizeFilename('aux.bin')  => '_aux.bin'
sanitizeFilename('nul')      => '_nul'
sanitizeFilename('com1.dat') => '_com1.dat'
sanitizeFilename('lpt2.log') => '_lpt2.log'

// Strips illegal characters and control bytes
sanitizeFilename('file*with:invalid<chars>.zip') => 'file_with_invalid_chars_.zip'
sanitizeFilename('file\u0000with\u001fcontrols.bin') => 'file_with_controls.bin'
```

### 3.2 Path Traversal & Escape Prevention
The engine enforces `isPathInside()` and `safeJoin()` before writing to disk:
- Resolves normalized, canonical paths.
- Verifies that target files resolve strictly inside the authorized download directory.
- Rejects paths containing `..` escape sequences or drive boundary crossings (`file:///C:/boot.ini`).

### 3.3 URL Scheme Whitelisting
`validateDownloadUrl()` strictly enforces protocol boundaries:
- **Accepted Schemes:** `http:`, `https:`
- **Blocked Dangerous Schemes:**
  - `file:` (Prevents local file reads or overwrite).
  - `javascript:` (Prevents XSS / script execution).
  - `data:` (Prevents payload smuggling).
  - `ftp:` (Deprecated and unencrypted).
  - `ws:`, `wss:` (Prevents socket hijacking).
  - `chrome:`, `edge:` (Prevents browser internal page manipulation).
- **Embedded Credentials:** URLs containing `user:pass@host` are rejected to prevent credential leakage.

---

## 4. NATIVE MESSAGING & NAMED PIPE IPC SECURITY

### 4.1 Threat Model
A malicious local process or unauthorized browser extension might attempt to connect to the desktop application's local IPC to trigger unauthorized downloads or execute code.

### 4.2 Defensive Mitigations
1. **Dynamic Authentication Secret:**
   - On startup, `NativePipeServer` generates a 256-bit cryptographically secure random token (`crypto.randomBytes(32).toString('hex')`).
   - The token is stored at `${dataDir}/ipc-secret.dat` with `0o600` user-only permissions.
2. **Timing-Safe Token Comparison:**
   - Incoming IPC messages must provide the `secret`.
   - The token is verified using `crypto.timingSafeEqual()` to eliminate timing attack side channels.
   - Requests without a token or with an invalid token are rejected with `AUTH_FAILED`.
3. **Framing & Payload Limits:**
   - Pipe messages are strictly bounded to `MAX_MESSAGE_SIZE = 1 MiB` to prevent buffer overflow or memory exhaustion denial of service.
   - Only strictly enumerated operations (`get_status`, `submit_download`) are permitted; all unknown operations are rejected.
4. **Idempotency Protection:**
   - Every request includes a `requestId`. Rapid duplicate requests (e.g., accidental double-clicks or browser retries) are served from an ephemeral 60-second cache without launching duplicate network streams.

---

## 5. SQLITE DATABASE RESILIENCE & QUARANTINE

### 5.1 Storage Security & Integrity
- **Node:SQLite Native Driver:** Uses Node.js built-in `node:sqlite`, eliminating 3rd-party C++ binary vulnerabilities.
- **SQL Injection Immunity:** All database operations utilize parameterized queries (`?` placeholders). No string concatenation is used for queries.
- **Foreign Key Cascades:** Database constraints enforce referential integrity (`foreign_keys = ON`), preventing orphan records.

### 5.2 Automatic Corruption Quarantine
If the SQLite database file is corrupted on disk (e.g. disk bad sectors or power loss):
- `BarqDatabase.open()` executes an integrity check (`PRAGMA quick_check`).
- If corrupted, the damaged file and its WAL sidecars are automatically quarantined to `${dbPath}.corrupt-${timestamp}`.
- A fresh, healthy database schema is automatically re-initialized without crashing the application.

---

## 6. RESIDUAL RISKS & RECOMMENDATIONS

| Risk Item | Current Mitigation | Future Enhancement (Milestone 6+) |
| :--- | :--- | :--- |
| **Downloaded Malware Execution** | Files are downloaded inertly without automatic execution. User must explicitly click "Open File". | Integrate Windows Defender Antivirus scanning via Windows AMSI API upon download completion. |
| **Untrusted SSL Certificates** | Node.js `https` enforces valid CA trust by default; self-signed certs are rejected. | Optional user setting for enterprise proxy custom CA cert imports. |
| **Disk Space Exhaustion** | Stream backpressure prevents RAM bloat; write errors throw clean user exceptions. | Add pre-flight disk space check before accepting massive 100+ GB downloads. |
