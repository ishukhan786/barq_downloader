# BARQ Downloader — Milestone 4 Installation & Setup Guide
## Chrome & Microsoft Edge Browser Companion Setup

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Target Platform:** Windows 10 / Windows 11 x64  
**Date:** October 2026  

---

### 1. Prerequisites

1. BARQ Downloader desktop application installed and working in `D:\Projects\BARQ_DOWNLOADER\`.
2. Google Chrome (v110+) and/or Microsoft Edge (v110+).
3. Node.js (v22+) available on system `PATH`.

---

### 2. Step-by-Step Installation

#### Step 1: Register Native Messaging Host
Open PowerShell or Command Prompt and execute:
```powershell
cd D:\Projects\BARQ_DOWNLOADER\native-host
.\register-host.ps1
```
*Verification:* You should see `[OK] Registered for Google Chrome` and `[OK] Registered for Microsoft Edge`.

#### Step 2: Load Extension in Google Chrome
1. In Google Chrome address bar, open: `chrome://extensions/`
2. Enable the **"Developer mode"** toggle in the top-right corner.
3. Click the **"Load unpacked"** button.
4. Select directory: `D:\Projects\BARQ_DOWNLOADER\browser-extension`
5. The extension will load with ID: `gnbkgloidbhnmbllllgaflmblimmhgli`.

#### Step 3: Load Extension in Microsoft Edge
1. In Microsoft Edge address bar, open: `edge://extensions/`
2. Enable **"Developer mode"** in the left navigation menu.
3. Click **"Load unpacked"**.
4. Select directory: `D:\Projects\BARQ_DOWNLOADER\browser-extension`
5. The extension will load and appear in the toolbar.

---

### 3. Verification & Testing

1. Start BARQ Downloader (`npm start` or desktop shortcut).
2. Click the BARQ lightning icon in the browser toolbar.
3. The popup will display **"Connected"** with a glowing green status indicator.
4. Right-click any downloadable link or image on the web and click **"Download with BARQ"**.
5. The download will appear in BARQ Downloader immediately with progress, multi-segment acceleration, and verified completion.

---

### 4. Clean Uninstallation

To remove all browser registrations:
```powershell
cd D:\Projects\BARQ_DOWNLOADER\native-host
.\unregister-host.ps1
```
In `chrome://extensions/` or `edge://extensions/`, click **"Remove"** on the BARQ Downloader card.
