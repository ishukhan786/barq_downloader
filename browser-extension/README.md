# BARQ Downloader — Browser Companion Extension (برق ڈاؤنلوڈر)

Official Google Chrome and Microsoft Edge browser companion extension for **BARQ Downloader**.

---

## 1. Overview & Capabilities

The BARQ Downloader browser extension allows users to send file download tasks directly from Google Chrome and Microsoft Edge to the high-speed desktop download engine with a single click.

### Key Features:
- **Right-Click Context Menu:** Right-click any downloadable link, image, or selected URL and choose **"Download with BARQ"**.
- **Toolbar Action Popup:** High-speed URL addition dialog with real-time application reachability status, URL validation, and optional filename hints.
- **Native Messaging Integration:** Communicates over Chrome & Edge's native messaging protocol with zero open public network ports.
- **Manifest V3 Compliant:** Built to latest Chromium extension standards with non-persistent background service workers.

---

## 2. Installation & Loading (Developer Mode)

### In Google Chrome:
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Toggle on **"Developer mode"** in the top-right corner.
3. Click the **"Load unpacked"** button in the top-left toolbar.
4. Select the folder: `D:\Projects\BARQ_DOWNLOADER\browser-extension`.
5. Confirm that **"BARQ Downloader"** appears in the extensions list with ID `gnbkgloidbhnmbllllgaflmblimmhgli`.

### In Microsoft Edge:
1. Open Microsoft Edge and navigate to `edge://extensions/`.
2. Turn on **"Developer mode"** in the left sidebar.
3. Click **"Load unpacked"** at the top.
4. Select the folder: `D:\Projects\BARQ_DOWNLOADER\browser-extension`.
5. Confirm that **"BARQ Downloader"** appears enabled.

---

## 3. Registering the Native Messaging Host

Before the extension can communicate with BARQ Downloader, the Native Messaging Host must be registered in the Windows Registry:

### Option A: Using PowerShell
Open PowerShell (no administrator privileges needed) and run:
```powershell
cd D:\Projects\BARQ_DOWNLOADER\native-host
.\register-host.ps1
```

### Option B: Using Node.js
```bash
cd D:\Projects\BARQ_DOWNLOADER
node -e "require('./native-host/registry-manager').RegistryManager.register()"
```

### Option C: In BARQ Desktop Application
Open BARQ Downloader, navigate to **Settings** → **Browser Extensions**, and click **"Register Host"**.

---

## 4. Permissions Requested

- `contextMenus`: Used exclusively to register the "Download with BARQ" right-click context menu.
- `nativeMessaging`: Enables local communication with `com.barq.downloader` native host.
- `storage`: Preserves user preferences and transient UI state.
- `activeTab`: Reads the current tab URL when the user explicitly opens the toolbar popup.

*No broad host permissions (`<all_urls>`, `*://*/*`) or browsing history permissions are requested.*
