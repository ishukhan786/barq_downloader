# BARQ Downloader — Milestone 4 Security & Threat Model

**Topic:** Browser Extension Integration & Native Messaging Security  
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Date:** October 2026  

---

### 1. Security Architecture & Threat Boundaries

Communication crosses three distinct trust boundaries:
1. **Untrusted Web Page / User Action** → **Browser Extension Service Worker**
2. **Browser Extension Service Worker** → **Native Messaging Host (`barq-native-host.bat`)**
3. **Native Messaging Host** → **BARQ Desktop Application (`\\\\.\\pipe\\barq-downloader-ipc`)**

---

### 2. Threat Analysis & Mitigations

#### A. Arbitrary Local Web Server Exploitation (CSRF/DNS Rebinding)
- **Threat:** Many download managers run an unauthenticated HTTP server on `http://127.0.0.1:port`. Malicious websites can use JavaScript `fetch()` or DNS rebinding to command the download manager to download arbitrary malware.
- **BARQ Mitigation:** BARQ **does NOT expose an unauthenticated HTTP server**. All browser communications route exclusively through Chromium's Native Messaging subsystem, which enforces explicit cryptographic `allowed_origins` checks at the browser C++ layer.

#### B. Native Host Hijacking & Impersonation
- **Threat:** Unrelated local processes or extensions attempting to connect to BARQ's Named Pipe.
- **BARQ Mitigation:**
  1. On launch, BARQ generates a **cryptographically random 256-bit token** (`crypto.randomBytes(32)`).
  2. The token is stored in `ipc-secret.dat` with mode `0600` inside the user's local data directory (protected by Windows NTFS User ACLs).
  3. Every IPC frame requires the secret token.
  4. Authentication verification utilizes `crypto.timingSafeEqual()` to neutralize side-channel timing attacks.

#### C. Command Injection & Arbitrary Code Execution
- **Threat:** Malicious payload passing shell metacharacters (`&`, `|`, `;`, `powershell`) to execute programs.
- **BARQ Mitigation:**
  - The Native Host never invokes `child_process.exec()` or shell command strings.
  - The Named Pipe server exclusively accepts `get_status` and `submit_download` operations.
  - No shell execution, arbitrary file paths, or file writes are permitted.

#### D. Directory Traversal & Device Name Exploits
- **Threat:** Attacker passes `filenameHint: "../../../../Windows/System32/evil.exe"` or `CON.txt`.
- **BARQ Mitigation:**
  - `filenameHint` is treated as untrusted.
  - Run through `sanitizeFilename()` which strips all directory separators (`/`, `\`), eliminates traversal tokens (`..`), and prepends an underscore to Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`).
  - Target path is strictly resolved within the user's configured download directory.

#### E. Protocol Injection
- **Threat:** Submitting `file:///`, `javascript:`, or `data:` URLs to read local files or trigger browser script execution.
- **BARQ Mitigation:**
  - Evaluated against `validateDownloadUrl()`: only `http:` and `https:` schemes are permitted.
  - Embedded credentials (`http://user:pass@host/`) and control characters are rejected immediately.
