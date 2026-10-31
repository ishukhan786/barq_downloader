# BARQ Downloader Browser Extension — Privacy Policy

**Last Updated:** October 2026  
**Application:** BARQ Downloader Browser Companion (برق ڈاؤنلوڈر)  

---

## 1. Principles & Commitment

BARQ Downloader is built with user privacy and system security as foundational requirements. The browser extension does not track user browsing activity, collect telemetry, or transmit data to external third parties.

---

## 2. Information Handled by the Extension

### A. Download URLs
- **What is collected:** Only the specific URL that the user explicitly selects via the **"Download with BARQ"** context menu or submits through the toolbar popup.
- **Purpose:** Passed directly over a local Windows Native Messaging pipe to the running BARQ desktop application so that the file can be downloaded.
- **Storage:** URLs are stored solely in the local SQLite database (`dev-data/barq.db` or `%LOCALAPPDATA%\BARQ Downloader\barq.db`) on the user's computer.

### B. What is NEVER Collected or Transmitted:
- ❌ No web browsing history
- ❌ No passwords, login credentials, or autofill data
- ❌ No session cookies or authorization tokens
- ❌ No page DOM content or form data
- ❌ No telemetry, tracking beacons, or analytics
- ❌ No advertising IDs or personal identifiers

---

## 3. Permissions Explanation

| Permission | Purpose & Scope |
|---|---|
| `contextMenus` | Registers right-click menu items on links, images, and text selections. |
| `nativeMessaging` | Establishes a local stdin/stdout pipe connection to `barq-native-host.bat`. |
| `storage` | Stores extension-local state (e.g. last connection status). |
| `activeTab` | Populates the URL field in the popup dialog only when the user clicks the toolbar icon. |

---

## 4. Local Processing & Security

All communications between the browser extension and the BARQ Downloader desktop application occur strictly **on the local machine** via Windows Named Pipes and Native Messaging. No data leaves the device.

---

## 5. Contact & Support

For issues, questions, or auditing:
- Repository: `D:\Projects\BARQ_DOWNLOADER\`
- Product: BARQ Downloader — Speed at Every Click.
