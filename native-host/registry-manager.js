'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const DEFAULT_EXTENSION_ID = 'gnbkgloidbhnmbllllgaflmblimmhgli';

const CHROME_KEY = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.barq.downloader';
const EDGE_KEY = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.barq.downloader';

class RegistryManager {
  static getManifestPath() {
    return path.resolve(__dirname, 'com.barq.downloader.json');
  }

  static getBatPath() {
    return path.resolve(__dirname, 'barq-native-host.bat');
  }

  /**
   * Registers the Native Messaging Host for Chrome and Edge in the Windows Registry.
   */
  static register(extensionId = DEFAULT_EXTENSION_ID) {
    if (process.platform !== 'win32') {
      return { ok: false, error: 'Native Messaging registration is only supported on Windows.' };
    }

    const batPath = this.getBatPath();
    const manifestPath = this.getManifestPath();

    if (!fs.existsSync(batPath)) {
      return { ok: false, error: `Host bat file not found: ${batPath}` };
    }

    // 1. Generate Manifest
    const manifestData = {
      name: 'com.barq.downloader',
      description: 'BARQ Downloader Native Messaging Host',
      path: batPath,
      type: 'stdio',
      allowed_origins: [
        `chrome-extension://${extensionId}/`,
        `extension://${extensionId}/`,
      ],
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf8');

    // 2. Set Registry Keys
    try {
      execSync(`reg add "${CHROME_KEY}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' });
      execSync(`reg add "${EDGE_KEY}" /ve /t REG_SZ /d "${manifestPath}" /f`, { stdio: 'pipe' });
      return { ok: true, manifestPath, extensionId };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Removes the Native Messaging Host registry keys.
   */
  static unregister() {
    if (process.platform !== 'win32') return { ok: true };

    try {
      try { execSync(`reg delete "${CHROME_KEY}" /f`, { stdio: 'pipe' }); } catch {}
      try { execSync(`reg delete "${EDGE_KEY}" /f`, { stdio: 'pipe' }); } catch {}
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Checks current registration status for Chrome and Edge.
   */
  static checkStatus() {
    if (process.platform !== 'win32') {
      return { chromeRegistered: false, edgeRegistered: false, manifestExists: false };
    }

    const manifestPath = this.getManifestPath();
    const manifestExists = fs.existsSync(manifestPath);

    let chromeRegistered = false;
    let edgeRegistered = false;

    try {
      const chromeOut = execSync(`reg query "${CHROME_KEY}" /ve`, { stdio: 'pipe' }).toString();
      if (chromeOut.includes(manifestPath)) chromeRegistered = true;
    } catch {}

    try {
      const edgeOut = execSync(`reg query "${EDGE_KEY}" /ve`, { stdio: 'pipe' }).toString();
      if (edgeOut.includes(manifestPath)) edgeRegistered = true;
    } catch {}

    return {
      chromeRegistered,
      edgeRegistered,
      manifestExists,
      manifestPath,
    };
  }
}

module.exports = { RegistryManager, DEFAULT_EXTENSION_ID };
