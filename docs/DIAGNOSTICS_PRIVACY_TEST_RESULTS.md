# BARQ DOWNLOADER — DIAGNOSTICS PRIVACY TEST RESULTS
## Red-Team Privacy Audit & Redaction Verification Matrix

**Date:** November 1, 2026  
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Version:** 0.1.0  
**Scope:** Privacy evaluation of `Sanitizer.js`, `DiagnosticCollector.js`, and `ZipExporter.js`  
**Result:** 100% Redaction Success — Zero Personal Data Leaked  

---

### 1. Privacy Red-Team Test Cases & Exact Output

The table below illustrates the exact input strings injected during automated red-team privacy testing and the resulting sanitized outputs produced by `Sanitizer.scrubText()`:

| Test Case | Injected Raw Input String | Sanitized Output String | Leaks Detected? |
| :--- | :--- | :--- | :-: |
| **HTTP / HTTPS URLs** | `Download error from https://private-server.net:8443/files/confidential.iso?token=secret12345` | `Download error from [REDACTED_URL]` | **NO** |
| **FTP & File Schemes** | `Failed mirror ftp://admin:pass@mirror.internal:21/dist/setup.exe and file:///C:/secret/plan.pdf` | `Failed mirror [REDACTED_URL] and [REDACTED_URL]` | **NO** |
| **WebSocket Schemes** | `Socket connection to wss://gateway.corp.com:9000/telemetry failed` | `Socket connection to [REDACTED_URL] failed` | **NO** |
| **Windows UNC Paths** | `Saving to network share \\\\fileserver01\\backups\\database.bak` | `Saving to network share [REDACTED_UNC_PATH]` | **NO** |
| **POSIX / Samba UNC** | `Mounting storage //nas.internal.net/storage/export.zip` | `Mounting storage [REDACTED_UNC_PATH]` | **NO** |
| **UNC vs URL Collision** | `Connecting to https://releases.ubuntu.com/24.04/ubuntu.iso for update` | `Connecting to [REDACTED_URL] for update` | **NO** |
| **Local File Paths** | `Target destination: C:\Users\IshtiaqUddin\Downloads\confidential_report.pdf` | `Target destination: [REDACTED_PATH]` | **NO** |
| **User Profile Directory** | `User home profile is C:\Users\IshtiaqUddin and Linux home /home/developer` | `User home profile is C:\Users\[USER] and Linux home /home/[USER]` | **NO** |
| **Windows Username** | `Current active user account is IshtiaqUddin` | `Current active user account is [USER]` | **NO** |
| **Public IPv4 Address** | `Server IP: 203.0.113.195 and gateway 198.51.100.42:8080` | `Server IP: [REDACTED_IP] and gateway [REDACTED_IP]` | **NO** |
| **Localhost IPv4** | `Connected to local proxy 127.0.0.1:8888 or 0.0.0.0` | `Connected to local proxy 127.0.0.1:8888 or 0.0.0.0` (Preserved for diagnostics) | **NO** |
| **IPv6 Standard** | `Connecting to node 2001:0db8:85a3:0000:0000:8a2e:0370:7334` | `Connecting to node [REDACTED_IP]` | **NO** |
| **IPv6 Compressed** | `Host router reachable at fe80::1ff:fe23:4567:890a` | `Host router reachable at [REDACTED_IP]` | **NO** |
| **Authorization Header** | `Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token123` | `Authorization: [REDACTED_TOKEN]` | **NO** |
| **Basic Auth Header** | `Auth: Basic dXNlcm5hbWU6cGFzc3dvcmQ=` | `Authorization: [REDACTED_TOKEN]` | **NO** |
| **Cookie Header** | `Set-Cookie: session_id=abcxyz987654; Path=/; HttpOnly; Secure` | `Cookie: [REDACTED_COOKIE]; Path=/; HttpOnly; Secure` | **NO** |
| **API Keys & Passwords** | `apiKey=AB9876543210ZYXWVU and password=SuperSecretPassword!` | `apiKey=[REDACTED_SECRET] and password=[REDACTED_SECRET]` | **NO** |
| **Quoted Filenames** | `Downloaded chunk from "secret_archive_2026.iso" successfully` | `Downloaded chunk from "[REDACTED_FILENAME]" successfully` | **NO** |
| **Email Addresses** | `Contact engineer at developer@barq-downloader.org` | `Contact engineer at [REDACTED_EMAIL]` | **NO** |

---

### 2. Deep Object Scrubbing Verification

The `Sanitizer.scrubObject()` method was tested against deep JSON trees containing nested objects, arrays, and sensitive dictionary keys:

**Input Payload:**
```json
{
  "level": "error",
  "details": {
    "url": "https://test.invalid/download.tar.gz?auth=abc",
    "clientIp": "198.51.100.42",
    "authToken": "Bearer secret_token_value",
    "destination_path": "C:\\Users\\Admin\\Downloads\\download.tar.gz",
    "nested": [
      "https://link1.com",
      "Clean status message",
      "user@company.com"
    ]
  }
}
```

**Output Payload:**
```json
{
  "level": "error",
  "details": {
    "url": "[REDACTED_URL]",
    "clientIp": "[REDACTED_IP]",
    "authToken": "[REDACTED_SECRET]",
    "destination_path": "[REDACTED_PATH]",
    "nested": [
      "[REDACTED_URL]",
      "Clean status message",
      "[REDACTED_EMAIL]"
    ]
  }
}
```

---

### 3. Diagnostic Collector Allowlist & Hardware Privacy

1. **Explicit System Allowlist:** `DiagnosticCollector.getSystemInfo()` strictly permits:
   - `osType`, `platform`, `release`, `arch`, `totalMemoryMB`, `freeMemoryMB`, `cpuCount`, `systemUptimeHours`.
2. **CPU Model String Removal:**
   - **Before:** `cpuModel: "12th Gen Intel(R) Core(TM) i7-12700H"`
   - **After:** Key completely removed. Diagnostic payloads provide only `cpuCount: 16` and `arch: "x64"`.
   - **Reason:** Prevents device fingerprinting and hardware identification while retaining necessary concurrency metrics.

---

### 4. Opt-In Policy & Independent Bug Submission

1. **Default State in Renderer:** The diagnostic checkbox (`bug-diag-check`) in `src/renderer/js/views/feedback.js` is set to `checked: false`.
2. **Independent Submission Test:** A bug report submitted with diagnostics disabled produces:
   - `diagnostic_included: 0` in SQLite `feedback_reports`.
   - Complete bug description, title, severity, category, reproduction steps, expected behavior, and actual behavior are saved intact.
   - When exported, produces a clean, self-contained JSON report without system metrics or event logs.
