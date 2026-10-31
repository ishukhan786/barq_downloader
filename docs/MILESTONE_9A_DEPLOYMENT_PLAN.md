# BARQ DOWNLOADER — MILESTONE 9A
## Public Beta Deployment Plan & Release Operational Runbook

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Brand:** BARQ  
**Tagline:** Speed at Every Click.  
**Version:** 0.1.0-beta.1  
**Release Tag:** `v0.1.0-beta.1` (Commit: `faecf72`)  
**Target Platform:** Windows 10/11 x64  
**Package ID:** `com.barq.downloader`  
**Current Milestone:** Milestone 9A — Public Beta Deployment Preparation  
**Deployment Status:** `PREPARED` (Deployment architecture validated, local integration verified, awaiting live domain DNS & TLS provisioning)

---

## 1. Executive Summary & Architecture Overview

BARQ Downloader incorporates a zero-trust, privacy-first, cryptographic auto-update system designed to operate without relying on complex, vulnerable third-party update frameworks.

### Cryptographic Security Model
1. **Transport Security:** Mandatory HTTPS (`https://updates.barq-downloader.org/`). Plain HTTP, unencrypted protocols, and insecure redirects are strictly rejected at the socket layer.
2. **Canonical Manifest Integrity:** Release manifests are canonicalized using RFC 8785 JSON Canonicalization Scheme (JCS) and signed offline using Ed25519 (Edwards-curve Digital Signature Algorithm).
3. **Root Key Trust Store:** The client contains a pinned, immutable trust store (`trusted-keys.json`) with root key ID `barq-beta-2026-k1` (`700f13a0e19488102ffebcf9b06ec9f9e71ecf942fb8355606d2c4e207b66df8`).
4. **Binary Checksum Verification:** Binary artifacts (`BARQ-Downloader-Setup-0.1.0.exe` and `BARQ-Downloader-Portable-0.1.0.exe`) are verified against SHA-256 digests declared in the signed manifest.
5. **Atomic Staging & Downgrade Protection:** Updates are staged into random isolated temporary files (`.tmp-*`) with 16-byte cryptographically secure nonces and verified before user prompt. Downgrades below the installed version or minimum supported version are rejected.
6. **No Silent Execution:** BARQ Downloader never silently executes or installs binaries; user consent via native modal confirmation is mandatory before installation.

---

## 2. Infrastructure & Hosting Architecture

### 2.1 Recommended Hosting Solutions
The update system requires pure static asset serving with high availability, low latency, and deterministic byte-range support:

| Provider | Evaluation | Suitability | Notes |
| :--- | :--- | :---: | :--- |
| **Cloudflare R2 + Cloudflare CDN** | Zero egress fees, global Edge caching, automated TLS 1.3 | **PRIMARY RECOMMENDED** | Ideal for cost-free binary downloads and instant global cache invalidation. |
| **AWS S3 + CloudFront** | Enterprise 99.999999999% durability, signed URLs | Alternative | Standard enterprise alternative. |
| **Hardened Nginx Origin Server** | Complete control, self-hosted Linux VPS (Debian/Ubuntu) | Supported | Requires managed Let's Encrypt renewal and failover. |
| **GitHub Releases / Pages** | Static hosting | Fallback | Free, but subject to rate limits and external platform policies. |

### 2.2 DNS & Domain Configuration
The BARQ update client resolves all updates relative to `DEFAULT_UPDATE_BASE_URL`:
- **Domain:** `updates.barq-downloader.org`
- **DNS Records (Cloudflare / Route 53):**
  - `updates.barq-downloader.org` `CNAME` -> `cname.r2.cloudflarestorage.com` (or origin IP `A` / `AAAA` records).
  - DNSSEC: **Enabled** to protect against DNS cache poisoning and spoofing.
  - Proxy Status: **Proxied (Cloudflare CDN enabled)**.

### 2.3 TLS / HTTPS Requirements
- **TLS Version:** TLS 1.3 mandatory (TLS 1.2 minimum acceptable; TLS 1.0/1.1 disabled).
- **Certificate Authority:** Let's Encrypt / Cloudflare Edge SSL / DigiCert.
- **HSTS:** `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- **Cipher Suites:** Forward secrecy mandatory (ECDHE-ECDSA-AES128-GCM-SHA256, ECDHE-RSA-AES128-GCM-SHA256, CHACHA20-POLY1305-SHA256).

---

## 3. Server Directory & URL Structure

The update server root must mirror the release channels and relative asset paths expected by `UpdateService.js`:

```text
/var/www/updates/ (or R2 bucket root)
│
├── beta/
│   ├── release-manifest.json             (RFC 8785 canonical JSON, max-age=60)
│   ├── release-manifest.json.sig         (Detached Ed25519 signature, max-age=60)
│   ├── SHA256SUMS.txt                    (SHA-256 checksums, text/plain)
│   ├── BARQ-Downloader-Setup-0.1.0.exe   (NSIS installer binary, immutable cache)
│   └── BARQ-Downloader-Portable-0.1.0.exe (Portable executable, immutable cache)
│
└── stable/
    ├── release-manifest.json             (Reserved for commercial general release)
    ├── release-manifest.json.sig
    └── SHA256SUMS.txt
```

### URL Mapping
- **Beta Manifest:** `https://updates.barq-downloader.org/beta/release-manifest.json`
- **Beta Signature:** `https://updates.barq-downloader.org/beta/release-manifest.json.sig`
- **Setup Binary:** `https://updates.barq-downloader.org/beta/BARQ-Downloader-Setup-0.1.0.exe`
- **Portable Binary:** `https://updates.barq-downloader.org/beta/BARQ-Downloader-Portable-0.1.0.exe`

---

## 4. Release Publication Workflow (Operational Runbook)

### Step 1: Build & Verify Production Artifacts
Execute from an isolated, clean build workstation:
```bash
git checkout v0.1.0-beta.1
npm ci
npm run syntax
npm test
npm run smoke
npm run dist:win
```

### Step 2: Compute SHA-256 Checksums
Compute cryptographically verified digests from the built artifacts in `dist/`:
```bash
certutil -hashfile "dist/BARQ-Downloader-Setup-0.1.0.exe" SHA256
certutil -hashfile "dist/BARQ-Downloader-Portable-0.1.0.exe" SHA256
```
Confirm the SHA-256 matches the release record:
- Setup: `c074be896f4325492d3080ff9f91dbbbdddf2be3bfa86fb0ba30e0e0a5c4d32a`
- Portable: `5db41217e923e3cb8fb7e0fe5bc7ff036c64606132d721bf0b601f0c29f2eb5e`

### Step 3: Prepare Canonical Release Manifest
Prepare `release-manifest.json` adhering to Schema Version 1:
```json
{
  "schemaVersion": 1,
  "appId": "com.barq.downloader",
  "channel": "beta",
  "version": "0.1.0",
  "minimumSupportedVersion": "0.1.0",
  "releaseNotes": "BARQ Downloader Public Beta 1 (Milestone 8 release).",
  "publishedAt": "2026-11-01T00:00:00.000Z",
  "artifacts": [
    {
      "type": "installer",
      "platform": "win32",
      "arch": "x64",
      "filename": "BARQ-Downloader-Setup-0.1.0.exe",
      "sha256": "c074be896f4325492d3080ff9f91dbbbdddf2be3bfa86fb0ba30e0e0a5c4d32a",
      "size": 69274928
    },
    {
      "type": "portable",
      "platform": "win32",
      "arch": "x64",
      "filename": "BARQ-Downloader-Portable-0.1.0.exe",
      "sha256": "5db41217e923e3cb8fb7e0fe5bc7ff036c64606132d721bf0b601f0c29f2eb5e",
      "size": 69022648
    }
  ]
}
```

### Step 4: Offline Ed25519 Detached Signing
Using the air-gapped / offline release signing key (`barq-beta-2026-k1`):
```bash
node scripts/sign-manifest.js \
  --manifest dist/beta/release-manifest.json \
  --key /path/to/secure-offline-keys/barq-beta-2026-k1.pem \
  --out dist/beta/release-manifest.json.sig
```
> [!IMPORTANT]
> The private signing key must NEVER be uploaded to web servers, committed to Git repositories, or stored on internet-facing machines. Signing must always occur offline or within a hardware security module (HSM).

### Step 5: Upload to Staging Bucket / Origin
Sync the artifacts to the server or object storage:
```bash
# Upload large binary artifacts first
r2cmd upload dist/BARQ-Downloader-Setup-0.1.0.exe beta/
r2cmd upload dist/BARQ-Downloader-Portable-0.1.0.exe beta/

# Upload checksums and manifest
r2cmd upload dist/SHA256SUMS.txt beta/
r2cmd upload dist/release-manifest.json.sig beta/
r2cmd upload dist/release-manifest.json beta/
```
*(Uploading binaries before manifests ensures clients checking the manifest will never encounter HTTP 404 on binary fetch).*

---

## 5. Pre-Release Verification Procedure

Before routing public traffic or announcing release availability:
1. **Manifest Availability Test:**
   ```bash
   curl -sI https://updates.barq-downloader.org/beta/release-manifest.json
   # Verify HTTP/2 200, Content-Type: application/json, Cache-Control: no-cache
   ```
2. **Signature Availability Test:**
   ```bash
   curl -sI https://updates.barq-downloader.org/beta/release-manifest.json.sig
   # Verify HTTP/2 200, Content-Type: application/octet-stream
   ```
3. **Range Request Test on Artifacts:**
   ```bash
   curl -r 0-1023 -sI https://updates.barq-downloader.org/beta/BARQ-Downloader-Setup-0.1.0.exe
   # Verify HTTP/2 206 Partial Content, Content-Range: bytes 0-1023/...
   ```
4. **End-to-End Client Check:**
   Launch BARQ Downloader with `updateChannel: beta`, navigate to **Settings**, click **Check for Updates**, and confirm:
   - Status transitions: `Checking...` -> `Verifying Signature` -> `Up to Date` (or `New: v0.1.0` if installed version is earlier).
   - Zero console errors and zero CSP violations.

---

## 6. Disaster Recovery & Rollback Plan

### 6.1 Defective or Corrupted Release Binary
If a release binary is found to have defects post-publication:
1. **Never delete the old version binary** (to prevent 404s for active downloads).
2. **Revert the manifest:** Re-sign and publish the manifest of the previous stable/tested build or publish a patch release with an incremented SemVer (`0.1.1-beta.1`).
   - If rolling back, note that BARQ Downloader rejects manifests where `version < installedVersion` to prevent downgrade attacks. Therefore, a rollback is executed by publishing an incremented release version (e.g., `0.1.0-beta.2` built from the stable commit).
3. **Purge CDN Cache:**
   ```bash
   cloudflare purge-cache --zone <ZONE_ID> --files "https://updates.barq-downloader.org/beta/release-manifest.json" "https://updates.barq-downloader.org/beta/release-manifest.json.sig"
   ```

### 6.2 Emergency Signing Key Rotation
If the Ed25519 signing key `barq-beta-2026-k1` is suspected of compromise:
1. Revoke the key in the client configuration by deploying an expedited patch update with updated `src/main/updater/trusted-keys.json`.
2. Generate a new Ed25519 keypair: `barq-beta-2026-k2`.
3. In `trusted-keys.json`:
   ```json
   {
     "keys": [
       { "id": "barq-beta-2026-k2", "publicKey": "<NEW_HEX>", "active": true },
       { "id": "barq-beta-2026-k1", "publicKey": "...", "active": false, "revokedAt": "2026-11-01T..." }
     ]
   }
   ```
4. Re-sign all manifests with `barq-beta-2026-k2`.

---

## 7. Current Milestone 9A Readiness Assessment

- [x] Client update service implemented and validated (`UpdateService.js`).
- [x] Detached Ed25519 RFC 8785 canonical verification implemented (`SignatureVerifier.js`).
- [x] Manifest schema, size, downgrade, and range protections tested (`ManifestValidator.js`).
- [x] Comprehensive deployment validation test suite created (`milestone9a-deployment-validation.test.js`, 14/14 PASS).
- [x] Server configuration templates authored for Nginx, Cloudflare R2, and S3.
- [ ] Public DNS record `updates.barq-downloader.org` pointed to live hosting (Owner action required).
- [ ] TLS certificate issued for `updates.barq-downloader.org` (Owner action required).

**Designation:** `PREPARED` — All software engineering, verification test suites, configuration templates, and operational runbooks are complete and verified. Deployment can proceed immediately upon domain and infrastructure provisioning by the project owner.
