# BARQ DOWNLOADER — UPDATE SECURITY THREAT MODEL
## Cryptographic Update Verification & Threat Mitigation Architecture

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Package ID:** `com.barq.downloader`  
**Platform:** Windows 10/11 x64  
**Date:** November 1, 2026  
**Document Version:** 1.0.0 (Milestone 8)  
**Security Level:** CRITICAL (Application Auto-Update Trust Architecture)  

---

### 1. Executive Summary & Philosophy

The update infrastructure is the single most sensitive software component in a desktop application. A compromised or poorly designed update client can be weaponized to deliver arbitrary remote code execution to every installed endpoint.

BARQ Downloader adheres to the principle of **Zero Implicit Trust in Update Delivery**:
1. **Network Transport is Untrusted:** Even over TLS/HTTPS, Content Delivery Networks (CDNs), web servers, and DNS infrastructure can be hijacked, misconfigured, or seized. TLS alone provides transport privacy, *not* publisher authenticity.
2. **Metadata is Untrusted Until Cryptographically Proven:** An update manifest is untrusted input until its exact canonical bytes are verified against an offline, air-gapped asymmetric public key hardcoded into the application.
3. **Artifacts are Untrusted Until Hashed & Signed:** Downloaded executables are quarantined in isolated temporary storage and verified against expected SHA-256 digests and Authenticode publisher identity before any execution permission is granted.
4. **User Consent is Mandatory:** Zero silent background executions. Updates require explicit user authorization before application restart and installation.

---

### 2. Threat Actor Profiles & Attack Vectors

```
                      ATTACK SURFACE & THREAT MATRIX
                      
  [ Attacker Vectors ]                 [ BARQ Security Boundaries ]
  +--------------------------------+   +------------------------------------+
  | 1. Malicious / Seized CDN Host |-->| HTTPS Strict Validation & Key Check|
  +--------------------------------+   +------------------------------------+
  | 2. DNS Spoofing / BGP Hijack   |-->| Certificate Pinning & TLS Handshake|
  +--------------------------------+   +------------------------------------+
  | 3. Manifest Tampering / Injection|->| Ed25519 Canonical Detached Signature|
  +--------------------------------+   +------------------------------------+
  | 4. Artifact Byte Substitution  |-->| SHA-256 Digest & Byte Size Check   |
  +--------------------------------+   +------------------------------------+
  | 5. Replay of Old Signed Release|-->| Version Monotonicity & Downgrade Guard|
  +--------------------------------+   +------------------------------------+
  | 6. Staged Malware Execution    |-->| Isolated Random Staging & Authenticode|
  +--------------------------------+   +------------------------------------+
  | 7. Corrupted In-Place Upgrade  |-->| Pre-Migration SQLite VACUUM Backup |
  +--------------------------------+   +------------------------------------+
```

The update architecture specifically counters the following 12 attack scenarios:

#### Threat 1: Malicious or Compromised Update Server / CDN
- **Threat:** An attacker gains administrative control over the web server hosting update files and replaces installer executables with trojaned payloads.
- **Mitigation:** Server delivery of a checksum is insufficient because the attacker controls both the executable and the checksum. BARQ requires a detached Ed25519 digital signature generated with an offline private key. The server does *not* possess the private signing key. An attacker who modifies the manifest invalidates the cryptographic signature, causing BARQ to immediately abort.

#### Threat 2: DNS Hijacking & Insecure Network Interception (MitM)
- **Threat:** An attacker on the local network (e.g. coffee shop Wi-Fi or compromised router) manipulates DNS or intercepts plain HTTP traffic.
- **Mitigation:**
  - BARQ strictly mandates `https://` protocol schemes. Plain `http://`, `file://`, `ftp://`, `data:`, and `javascript:` URLs are rejected outright at the client protocol validation layer.
  - Cross-origin redirects to untrusted protocols or insecure schemes are strictly blocked.

#### Threat 3: Manifest Tampering & Attribute Injection
- **Threat:** An attacker attempts to inject malicious fields, path traversal sequences (`../../Windows/System32`), or unsupported extensions into the update manifest.
- **Mitigation:**
  - Canonical JSON serialization (RFC 8785 principles) ensures whitespace, key ordering, and floating-point representations are strictly normalized before signature verification.
  - Strict schema validation (`ManifestValidator.js`) enforces exact property types and regex rules.
  - Artifact names are treated as untrusted strings: path separators (`/`, `\`), null bytes, and traversal tokens (`..`) trigger immediate schema rejection. Only `.exe` artifacts matching `BARQ-Downloader-Setup-*.exe` or `BARQ-Downloader-Portable-*.exe` are permitted.

#### Threat 4: Artifact Substitution & Truncated Transfers
- **Threat:** An attacker serves a truncated file, an older executable, or substitutes the artifact payload during transfer.
- **Mitigation:**
  - The downloaded artifact is streamed directly into an isolated temporary file with a cryptographically random filename (`.tmp-[randomBytes(16).hex]`).
  - Upon download completion, BARQ calculates the full file SHA-256 digest and compares it against the signed manifest digest using timing-safe comparison (`crypto.timingSafeEqual`).
  - The exact byte count is verified against the signed manifest size. Truncated or padded files fail validation.

#### Threat 5: Replay Attacks & Downgrade Vulnerabilities
- **Threat:** An attacker serves a previously authentic, signed manifest for an older version of BARQ that contains a known, patched security flaw (downgrade attack).
- **Mitigation:**
  - Version monotonicity enforcement: BARQ compares the manifest version against the currently installed version using SemVer rules.
  - Manifests advertising a version lower than or equal to the current version are rejected as update candidates (`downgrade_rejected`).
  - A mandatory `minimumSupportedVersion` threshold prevents upgrading from an abandoned branch without intermediate migration.

#### Threat 6: Compromised Signing Key & Key Rotation
- **Threat:** A publisher's signing key is compromised or needs planned retirement.
- **Mitigation:**
  - The trusted verification key store (`trusted-keys.json`) supports multiple active and deprecated key IDs.
  - Each signature specifies a `keyId`. Manifests signed with an unknown or retired key ID are rejected.
  - Key rotation manifests are dual-signed by both the retiring key and the succeeding key to allow smooth trust propagation.

#### Threat 7: Local Filesystem Tampering & Race Conditions (TOCTOU)
- **Threat:** A local non-administrator process on the machine monitors the temporary directory and swaps the verified installer file immediately before execution (Time-Of-Check to Time-Of-Use).
- **Mitigation:**
  - Staging occurs in a dedicated user-restricted temporary directory created with strict file permissions (`0o700`).
  - Temporary files use cryptographically random filenames.
  - Post-verification execution occurs immediately from the staging handle or atomically moved destination.

#### Threat 8: Unintended Elevation & Silent Execution
- **Threat:** Updates execute silently in the background without user awareness, potentially interrupting active user operations or executing elevated setup scripts.
- **Mitigation:**
  - Zero silent updates. The user is presented with an update prompt showing the new version, publication date, and verified changelog.
  - Installation is only triggered when the user explicitly clicks "Install & Restart".
  - The NSIS installer runs with standard user privileges and requests elevation (UAC) only if installing to system-wide `Program Files`.

#### Threat 9: Database Corruption on Upgrade
- **Threat:** A new application version contains database migrations that fail halfway through due to disk space exhaustion or unexpected constraints, destroying user history.
- **Mitigation:**
  - Before applying any migrations, the database subsystem executes a WAL-consistent snapshot (`VACUUM INTO`) to a standalone backup file.
  - The backup is tested with `PRAGMA integrity_check`.
  - If migration fails, the database is rolled back to the backup snapshot, and an emergency recovery notification is displayed.

#### Threat 10: Channel Confusion (Beta vs. Stable)
- **Threat:** A beta release is accidentally served to users on the stable release channel, exposing them to pre-release regressions.
- **Mitigation:**
  - Strict channel separation: `beta` vs `stable`.
  - The client validates that the manifest `channel` matches the user's configured channel.
  - Switching from stable to beta requires explicit user confirmation.

#### Threat 11: Denial of Service via Resource Exhaustion
- **Threat:** A malicious server serves an infinitely streaming or gigabyte-sized manifest or artifact to exhaust memory and disk space.
- **Mitigation:**
  - Maximum manifest download size: 1 MB. Streams exceeding this size are severed immediately.
  - Maximum artifact download size: 250 MB (configurable ceiling).
  - Strict network connection timeouts (15s connect, 30s read).

#### Threat 12: Renderer-Triggered Code Execution
- **Threat:** A Cross-Site Scripting (XSS) or DOM injection vulnerability in the renderer triggers the main process to download and execute an arbitrary executable.
- **Mitigation:**
  - The renderer has zero filesystem or network capabilities.
  - IPC handler calls (`updater:checkForUpdates`, `updater:downloadUpdate`, `updater:installUpdate`) are strictly guarded with sender origin validation (`isTrustedSender`).
  - Update endpoints cannot be injected from the renderer; they are read exclusively from main-process configuration.

---

### 3. Cryptographic Verification Pipeline

The end-to-end update process must follow this strict sequential pipeline:

```
[ Step 1: Config & Channel Resolution ]
   |  Read user channel ('beta' or 'stable') and HTTPS update URL.
   v
[ Step 2: Fetch Release Manifest & Detached Signature ]
   |  Download release-manifest.json and release-manifest.json.sig over HTTPS.
   |  Enforce 1MB size limit and 15s timeout.
   v
[ Step 3: Canonicalize Manifest & Verify Ed25519 Signature ]
   |  Deterministically canonicalize manifest JSON bytes.
   |  Verify detached signature using embedded trusted public key.
   |  FAIL -> Abort immediately with "SIGNATURE_INVALID".
   v
[ Step 4: Strict Schema & Monotonicity Validation ]
   |  Validate schemaVersion, packageId == "com.barq.downloader", channel match.
   |  Validate semver: manifest.version > current.version.
   |  Validate platform: "win32-x64" entry exists with valid filename & sha256.
   |  FAIL -> Abort with "MANIFEST_INVALID" or "VERSION_NOT_NEWER".
   v
[ Step 5: User Notification & Consent ]
   |  Notify renderer UI that a verified update is available.
   |  Wait for user to request download.
   v
[ Step 6: Download Artifact to Isolated Staging ]
   |  Download artifact to .tmp-[random16].exe in secure temp directory.
   |  Track real download progress; enforce maximum size limit.
   v
[ Step 7: Verify Artifact Size & SHA-256 Digest ]
   |  Compute SHA-256 of downloaded file.
   |  Compare with manifest sha256 using timingSafeEqual.
   |  Verify file.size == manifest.size.
   |  FAIL -> Securely wipe temporary file; abort with "CHECKSUM_MISMATCH".
   v
[ Step 8: Optional Authenticode Verification ]
   |  If release policy mandates Authenticode, verify digital signature via signtool/PowerShell.
   |  FAIL -> Abort with "AUTHENTICODE_INVALID".
   v
[ Step 9: User Consent for Installation ]
   |  UI displays "Ready to Install" with verified green checkmarks.
   |  User clicks "Install & Restart".
   v
[ Step 10: Safe Application Shutdown & Installer Execution ]
   |  Close database cleanly; save pending download states.
   |  Execute verified installer with /S or standard interactive prompt.
   |  Exit main application process.
```

---

### 4. Cryptographic Primitives & Specifications

- **Digital Signature Algorithm:** Ed25519 (EdDSA over Curve25519) via Node.js `node:crypto`.
  - Chosen for high verification performance, small key and signature sizes (32-byte public key, 64-byte signature), resistance to side-channel attacks, and absence of complex parameter negotiation.
- **Digest Algorithm:** SHA-256 (`crypto.createHash('sha256')`).
- **Signature Format:** Base64-encoded raw 64-byte Ed25519 signature string or detached `.sig` file.
- **Canonicalization Specification:** Deterministic key sorting, UTF-8 encoding without BOM, normalized whitespace (no pretty-print indentation during hashing).
- **Public Key Embedding:** Stored as structured JSON in `src/main/updater/keys/trusted-keys.json`:
  ```json
  {
    "activeKeyId": "barq-beta-2026-k1",
    "keys": [
      {
        "id": "barq-beta-2026-k1",
        "algorithm": "ed25519",
        "publicKey": "BASE64_PUBLIC_KEY",
        "validFrom": "2026-10-01T00:00:00Z",
        "validUntil": "2028-10-01T00:00:00Z"
      }
    ]
  }
  ```
- **Private Key Isolation:** The private signing key (`barq-beta-2026-k1.private.pem`) is strictly stored on an offline, air-gapped machine or encrypted CI secrets store. It is **NEVER** checked into the repository, packaged into the ASAR archive, or exposed in client builds.

---

### 5. Summary of Security Guarantees

1. An attacker controlling the update web server cannot force clients to install modified or malicious executables without the offline Ed25519 private key.
2. An attacker on the local network cannot downgrade clients to vulnerable older builds.
3. An attacker cannot inject arbitrary disk paths into the manifest.
4. Clients will never automatically run an update without user consent.
5. Clients will never overwrite active user databases without a verified pre-migration backup.
