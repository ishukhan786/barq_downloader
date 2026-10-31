# BARQ Downloader — Native Messaging Host (`com.barq.downloader`)

Local bridge between Chromium browsers (Google Chrome, Microsoft Edge) and the BARQ Downloader desktop application on Windows.

---

## 1. Role & Architecture

```
[ Browser Extension ]
         │ (stdin/stdout with 4-byte uint32 LE length prefix)
         ▼
[ barq-native-host.bat ] -> [ barq-native-host.js ]
         │ (Windows Named Pipe: \\.\pipe\barq-downloader-ipc)
         │ (Authenticated with dynamic 256-bit token from ipc-secret.dat)
         ▼
[ BARQ Downloader Desktop Application ]
         │
         ▼
[ DownloadManager ] -> [ SQLite downloads table ]
```

---

## 2. File Manifest

- `barq-native-host.js`: Native Messaging stdio frame processor and Named Pipe client.
- `barq-native-host.bat`: Windows shell launcher invoked by Chrome/Edge.
- `com.barq.downloader.json`: Native Messaging manifest template defining executable path and allowed origins.
- `registry-manager.js`: Node.js module managing Windows registry registration under `HKCU`.
- `register-host.ps1`: Standalone PowerShell registration script.
- `unregister-host.ps1`: Standalone PowerShell unregistration script.

---

## 3. Registration Commands

### Register Native Host:
```powershell
cd D:\Projects\BARQ_DOWNLOADER\native-host
.\register-host.ps1
```

### Unregister Native Host:
```powershell
cd D:\Projects\BARQ_DOWNLOADER\native-host
.\unregister-host.ps1
```

---

## 4. Diagnostics & Troubleshooting

Diagnostic logs are written to:
- `stderr`
- `<dataDir>/native-host.log` (e.g. `dev-data/native-host.log` or `%LOCALAPPDATA%\BARQ Downloader\native-host.log`)

*Never write logs to stdout! Writing non-framed strings to stdout corrupts the binary Native Messaging protocol.*
