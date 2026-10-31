# BARQ Downloader v0.1.0 Release Notes
**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Release Tag:** `v0.1.0-beta.1`  
**Date:** November 1, 2026  
**Channel:** Public Beta  
**Target:** Windows 10/11 x64  

---

## 1. Executive Summary

BARQ Downloader version 0.1.0 represents the first official public beta release of the commercial-grade Windows download manager.

Engineered from the ground up to challenge legacy download managers like IDM, BARQ delivers modern visual ergonomics, high-throughput multi-segment downloads, browser extension integration for Google Chrome and Microsoft Edge, zero outbound telemetry, and a cryptographically hardened update infrastructure.

---

## 2. Release Highlights

### Multi-Segment Download Acceleration
- Automatically analyzes server HTTP Range headers to split large files into up to 16 parallel connection streams.
- Measured sustained throughput exceeding 85 MB/s on Gigabit connections with negligible RAM overhead (< 10 MB heap).
- Transparent fallback to resilient single-connection streaming when servers reject range requests.

### Browser Extension Integration (Chrome & Edge)
- Intercept downloads directly from Google Chrome and Microsoft Edge via Manifest V3 extensions.
- Right-click context menu "Download with BARQ" for links, video streams, audio, and documents.
- Authenticated Windows Native Messaging Host operating via high-speed local named pipe IPC.

### Privacy-First Diagnostics & Feedback
- Built-in local bug and feature reporting.
- Diagnostic logs are strictly opt-in and sanitized using an explicit allowlist.
- Zero analytics, zero metrics beaconing, and zero third-party network telemetry.

### Secure Update Infrastructure
- Update manifests verified with Ed25519 digital signatures and RFC 8785 canonicalization.
- Safe download staging into isolated temporary files with SHA-256 verification.
- Rejection of downgrade attacks and mandatory explicit user consent before installation.

---

## 3. Official Release Artifacts

| Artifact Name | Type | Size | SHA-256 Checksum |
| :--- | :--- | :--- | :--- |
| `BARQ-Downloader-Setup-0.1.0.exe` | NSIS Windows Installer | 55.4 MB | `77E5FEF43E2E694116CD4A511674ED9754C9190F0C058EF9B60BFBA9DFED6500` |
| `BARQ-Downloader-Portable-0.1.0.exe` | Portable Executable | 58.0 MB | `867AC6357C172BDCC81580A7712CC6DF9C104FD180631F9E31EBFF33E0EB213E` |
| `release-manifest.json` | Release Manifest | 1.1 KB | Verified with Ed25519 signature |
| `release-manifest.json.sig` | Detached Signature | 88 B | Signed with `barq-beta-2026-k1` |

---

## 4. System Requirements
- **OS:** Windows 10 (Build 19041+) or Windows 11 x64
- **Processor:** 64-bit Intel/AMD CPU (1.0 GHz+)
- **Memory:** 512 MB RAM minimum
- **Disk Space:** 200 MB free space
- **Network:** Active internet connection (HTTP/HTTPS)
