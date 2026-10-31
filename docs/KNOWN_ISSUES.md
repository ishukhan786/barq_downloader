# BARQ Downloader — Known Issues & Technical Limitations
**Version:** 0.1.0 Beta  
**Date:** November 2026  

This document lists known behaviors, platform constraints, and technical limitations in BARQ Downloader v0.1.0.

---

## 1. Windows Code Signing & SmartScreen Notice
- **Issue:** In development or self-built beta environments where a commercial Extended Validation (EV) Authenticode certificate is not configured via `BARQ_SIGNING_CERT`, Windows Defender SmartScreen displays: *"Windows protected your PC: Unknown publisher"*.
- **Impact:** Users must click *"More info"* -> *"Run anyway"* upon first execution of the installer.
- **Workaround / Resolution:** Standard for open-source and early public beta software prior to commercial certificate provisioning. Authenticode signing hooks are fully implemented in `src/main/updater/CodeSigning.js` and activate automatically once `BARQ_SIGNING_CERT` is provided in the build environment.

---

## 2. Browser Extension Sideloading in Developer Mode
- **Issue:** Extensions in unpacked source mode require enabling "Developer mode" in Google Chrome (`chrome://extensions`) and Microsoft Edge (`edge://extensions`).
- **Impact:** Minor friction during initial beta setup.
- **Resolution:** Commercial distribution in Milestone 9 will package and publish signed extensions to the Chrome Web Store and Microsoft Edge Add-ons catalog.

---

## 3. High-DPI Scaling on Multi-Monitor Setups
- **Issue:** Moving the window dynamically across monitors with drastically different DPI scaling (e.g. 100% on a 1080p secondary monitor vs 250% on a 4K primary monitor) may cause a momentary redraw flash.
- **Impact:** Purely visual artifact for ~100ms. No loss of state or download interruption.

---

## 4. Antivirus Heuristic False Positives on High-Concurrency Downloads
- **Issue:** Opening 16 simultaneous TCP socket connections to a single web host may trigger aggressive third-party firewall/antivirus network heuristic alerts.
- **Impact:** Download speeds may be artificially capped by local third-party firewalls.
- **Workaround:** Lower "Parallel Connections Per Download" from 16 to 4 or 8 in *Settings -> Download Engine & Queue*.
