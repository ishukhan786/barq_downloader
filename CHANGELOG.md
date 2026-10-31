# Changelog

All notable changes to **BARQ Downloader (برق ڈاؤنلوڈر)** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0-beta.1] - 2026-11-01

### Added
- **GitHub Releases Auto-Update Infrastructure (Milestone 9A.1):**
  - Integrated GitHub Releases API (`/repos/ishukhan786/barq_downloader/releases`) as primary zero-cost distribution source.
  - Channel-aware release discovery with SemVer filtering for `beta` (pre-releases) and `stable` channels.
  - Hop-by-hop HTTPS redirect security enforcing approved host allowlists (`objects.githubusercontent.com`, `github.com`).
  - Protection against redirect loops, HTTPS-to-HTTP downgrade attacks, and unapproved external mirrors.
  - Stripping of sensitive authorization headers during cross-origin redirect hops.
  - Release packaging tool `scripts/prepare-github-release.js` for automated manifest generation and SHA-256 computation.
- **Cryptographic Security & Verification Engine (Milestone 8 & 9A):**
  - Offline Ed25519 digital signature generation and verification with RFC 8785 JSON Canonicalization Scheme (JCS).
  - Pinned public key store (`trusted-keys.json`) with root key ID `barq-beta-2026-k1`.
  - Constant-time SHA-256 digest comparison (`crypto.timingSafeEqual`) for downloaded binary artifacts.
  - Downgrade protection and minimum supported version upgrade gate.
  - Isolated staging in temporary directories with 16-byte cryptographically secure random nonces.
  - Mandatory native user confirmation dialog before launching update installers.
- **Feedback & Diagnostic Support System (Milestone 7 & 7.1):**
  - Local feedback and bug reporting interface in renderer.
  - Zero-telemetry design with opt-in sanitized diagnostic logs and environment metrics.
  - PKZIP 2.0 export bundling with deep redaction of paths, usernames, IPs, URLs, tokens, and cookies.
- **Packaging & Windows Release Engineering (Milestone 6):**
  - Windows x64 NSIS installer (`BARQ-Downloader-Setup-0.1.0.exe`) and standalone portable executable (`BARQ-Downloader-Portable-0.1.0.exe`).
  - Automatic detection of portable mode beside `portable-data/` with fallback to `%LOCALAPPDATA%`.
- **Production Hardening (Milestone 5):**
  - Concurrency scheduler, event-loop latency monitoring (<50ms), memory leak baselines.
  - SQLite WAL mode, foreign key cascades, append-only migrations, and corruption quarantine.
- **Browser Extension & Native Messaging Host (Milestone 4):**
  - Chrome and Edge Manifest V3 extension with native named pipe IPC server and dynamic token authentication.
- **Multi-Segment Download Acceleration Engine (Milestone 3):**
  - HTTP Range header segmentation with up to 16 parallel connection streams.
  - Dynamic chunk planning, pause/resume, and seamless single-stream fallback.
