# BARQ DOWNLOADER — WINDOWS INSTALLATION & UPGRADE GUIDE
## Step-by-Step Deployment Instructions

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Version:** 0.1.0  
**Target Platform:** Windows 10 / Windows 11 (64-bit)

---

## 1. SYSTEM REQUIREMENTS

- **Operating System:** Windows 10 (Version 1903 or later) or Windows 11 x64.
- **Processor:** Intel / AMD 64-bit processor (x86_64).
- **RAM:** Minimum 512 MB (1 GB or more recommended).
- **Storage:** ~250 MB free disk space for application files.
- **Browser (Optional):** Google Chrome (v100+) or Microsoft Edge (v100+) for browser extension integration.

---

## 2. INSTALLATION METHODS

BARQ Downloader provides two distribution formats:
1. **Standard Windows Installer (`BARQ-Downloader-Setup-0.1.0.exe`):** Recommended for daily use on a personal PC. Sets up Start Menu shortcuts, Desktop shortcut, and Windows integration.
2. **Portable Executable (`BARQ-Downloader-Portable-0.1.0.exe`):** Recommended for USB flash drives or systems without installation privileges. Stores all settings and databases in a local folder without modifying the host PC.

---

## 3. METHOD A: STANDARD INSTALLER (RECOMMENDED)

### Step 1: Download & Verify
1. Download `BARQ-Downloader-Setup-0.1.0.exe` from the official release page.
2. (Optional) Verify the SHA-256 checksum in PowerShell:
   ```powershell
   Get-FileHash .\BARQ-Downloader-Setup-0.1.0.exe -Algorithm SHA256
   ```
   Confirm the hash matches:
   `1015B1DC6CB38EE21D0F12C2BA02F7DEF929C61BE5316958607B3253EC9173FA`

### Step 2: Handle Windows SmartScreen (Development Builds)
Because staging builds are unsigned, Windows Defender SmartScreen may display:
> *"Windows protected your PC"*
> *"Microsoft Defender SmartScreen prevented an unrecognized app from starting."*

1. Click **More info**.
2. Click the **Run anyway** button.

### Step 3: Installation Wizard
1. The BARQ Downloader Setup Wizard will open.
2. Choose your installation location (Default: `%LOCALAPPDATA%\Programs\BARQ Downloader`, or custom folder).
3. Click **Install**.
4. Once completed, check **Run BARQ Downloader** and click **Finish**.
5. BARQ Downloader will launch and create Desktop and Start Menu shortcuts.

---

## 4. METHOD B: PORTABLE EXECUTABLE

1. Download `BARQ-Downloader-Portable-0.1.0.exe`.
2. Move the file to your desired folder (e.g. `D:\Tools\BARQ\` or a USB flash drive).
3. Double-click `BARQ-Downloader-Portable-0.1.0.exe` to launch immediately.
4. All SQLite databases, settings, and logs will be stored in a `portable-data/` folder created automatically beside the executable.

---

## 5. BROWSER EXTENSION SETUP (CHROME & EDGE)

BARQ Downloader includes an official browser extension in the `resources/browser-extension/` directory.

### Enabling in Google Chrome or Microsoft Edge:
1. Open your browser and navigate to:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. Enable **Developer mode** (toggle switch in the top-right corner).
3. Click **Load unpacked**.
4. Browse to BARQ Downloader's installed resources:
   - Default path: `%LOCALAPPDATA%\Programs\BARQ Downloader\resources\browser-extension\`
5. Click **Select Folder**.
6. The BARQ Downloader extension icon will appear in your browser toolbar.
7. Right-click any downloadable link or video -> Select **Download with BARQ**.

---

## 6. UPGRADING TO A NEW VERSION

Upgrading BARQ Downloader is 100% non-destructive and requires no manual database backup:

1. Download the new installer (e.g. `BARQ-Downloader-Setup-0.2.0.exe`).
2. Close any running instance of BARQ Downloader.
3. Run the installer.
4. **Data Guarantee:**
   - The installer updates only the application binaries in `%LOCALAPPDATA%\Programs\BARQ Downloader`.
   - Your SQLite database (`%LOCALAPPDATA%\BARQ Downloader\barq.db`), custom settings, and completed download history are **automatically preserved**.
   - Any incomplete downloads will appear ready to resume.

---

## 7. UNINSTALLATION & DATA PRESERVATION

### How to Uninstall:
1. Open Windows **Settings** -> **Apps** -> **Installed apps** (or Control Panel -> Programs and Features).
2. Locate **BARQ Downloader**.
3. Click the three dots `...` and select **Uninstall**.
4. Follow the uninstallation prompts.

### What is Removed vs Preserved:
- **Removed:** Application executable files, libraries, Desktop shortcut, and Start Menu shortcut.
- **Preserved (Never Deleted):**
  - All downloaded files in `C:\Users\<user>\Downloads\BARQ\` remain on disk.
  - User settings and download history in `%LOCALAPPDATA%\BARQ Downloader\` remain intact so you can reinstall anytime without losing history.
  - To completely remove user history, manually delete `%LOCALAPPDATA%\BARQ Downloader\`.
