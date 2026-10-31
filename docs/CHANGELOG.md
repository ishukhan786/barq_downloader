# Changelog

All notable changes to the **BARQ Downloader (برق)** project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-11-01

### Added
- **Download Engine Core (Milestone 1–2):**
  - High-performance streaming HTTP/HTTPS download engine with chunked transfer support.
  - Resume interrupted transfers from byte offsets using HTTP 206 Partial Content.
  - Automatic collision suffix handling (`(1)`, `(2)`) to prevent overwriting existing files.
  - Dynamic speed limiter and bandwidth throttler.
  - Embedded SQLite database running WAL mode, `synchronous=NORMAL`, and foreign key enforcement.
- **Multi-Segment Acceleration Engine (Milestone 3):**
  - Parallel Range connection splitting (up to 16 concurrent segment streams).
  - Dynamic segment boundary planner with automatic single-connection fallback on servers without Range support.
  - Atomic part-file assembly and post-download SHA-256 verification.
- **Browser Extension Integration (Milestone 4):**
  - Chrome and Microsoft Edge browser extensions (Manifest V3).
  - Windows Native Messaging Host with authenticated local Named Pipe IPC.
  - Right-click context menu "Download with BARQ" and extension toolbar popup.
  - Automated Native Host registry installer for Windows.
- **Production Hardening (Milestone 5):**
  - Tested against 1 GB real streaming payloads and simulated unstable networks.
  - Automatic retry with exponential backoff on HTTP 429 (Retry-After) and HTTP 5xx.
  - Stale ETag detection with clean restart from byte 0.
  - Comprehensive memory leak and event-loop lag monitoring (< 50ms under heavy stress).
- **Windows Packaging & Release Engineering (Milestone 6):**
  - NSIS Windows x64 per-user installer (`BARQ-Downloader-Setup-0.1.0.exe`).
  - Single-file portable edition (`BARQ-Downloader-Portable-0.1.0.exe`).
  - Bit-for-bit SHA-256 checksum verification (`SHA256SUMS.txt`).
- **Feedback, Diagnostics & Privacy System (Milestone 7 & 7.1):**
  - Built-in bug report and feature request management system.
  - Privacy-first diagnostic export with zero outbound network telemetry.
  - Redaction of personal usernames, UNC paths, IP addresses, tokens, and cookies via strict allowlist sanitizer.
- **Public Beta Release & Secure Update Infrastructure (Milestone 8):**
  - Release manifest schema version 1 with strict boundary and path traversal validation.
  - Detached Ed25519 digital signature signing and verification using RFC 8785 canonicalization.
  - Isolated `.tmp-*` staging directory with random nonces for update verification.
  - SQLite pre-migration WAL-consistent snapshots via `VACUUM INTO` with rollback recovery.
  - Dual release channels: `beta` (default) and `stable`.
  - In-app Software Updates card in Settings view with explicit user consent dialogs.
