# BARQ DOWNLOADER — PRODUCTION RELEASE CHECKLIST
## Release Engineering & Quality Gate Procedure

**Product:** BARQ Downloader (برق ڈاؤنلوڈر)  
**Version:** 0.1.0  
**Target Platform:** Windows 10/11 x64  
**Maintainer:** Release Engineering Team

---

## 1. PRE-RELEASE QUALITY GATES (MUST BE 100% GREEN)

Before publishing any release, execute the following verification commands from the project root (`D:\Projects\BARQ_DOWNLOADER\`):

- [x] **Syntax Validation:**
  ```powershell
  node scripts/check-syntax.js
  # Must report: "Syntax check PASSED: all 59 files (CJS + ESM) parsed cleanly."
  ```

- [x] **Automated Test Suite (132 Tests):**
  ```powershell
  npm test
  # Must report: 132 passed, 0 failed, 0 skipped.
  ```

- [x] **Electron Runtime Smoke Test:**
  ```powershell
  node scripts/smoke.js
  # Must report: "Smoke test SUCCESSFUL. All verification checks passed."
  ```

- [x] **Packaged Application Execution:**
  ```powershell
  node --test tests/milestone6-installer.test.js
  # Must report: 8 passed, 0 failed.
  ```

---

## 2. PACKAGING & BUILD COMPILATION

- [x] **Clean Output Directory:**
  Ensure the `dist/` folder is cleanly prepared:
  ```powershell
  Remove-Item -Recurse -Force dist -ErrorAction SilentlyContinue
  ```

- [x] **Compile Release Artifacts:**
  ```powershell
  npm run dist
  ```
  Expected Output Files in `dist/`:
  - `BARQ-Downloader-Setup-0.1.0.exe` (NSIS Installer, ~115–125 MB)
  - `BARQ-Downloader-Portable-0.1.0.exe` (Portable Single-file, ~105–115 MB)
  - `BARQ-Downloader-Setup-0.1.0.exe.blockmap` (Differential update map)

- [x] **Generate Cryptographic Checksums:**
  ```powershell
  Get-FileHash dist/BARQ-Downloader-Setup-0.1.0.exe, dist/BARQ-Downloader-Portable-0.1.0.exe -Algorithm SHA256 |
    ForEach-Object { "$($_.Hash) *$($_.Path | Split-Path -Leaf)" } |
    Out-File -Encoding ascii dist/SHA256SUMS.txt
  ```

---

## 3. AUTHENTICODE SIGNING PROCEDURE (PRODUCTION ONLY)

> [!IMPORTANT]
> Never embed `.pfx` or `.p12` certificates or passwords in source control. Private signing keys must be injected only via CI/CD secrets (e.g. GitHub Actions Secrets or Azure Key Vault).

### Option A: Standard EV/OV Code Signing Certificate
When using a hardware token or local PFX in CI:
```powershell
# Set environment variables in CI/CD runner
$env:CSC_LINK = "path/to/certificate.pfx"
$env:CSC_KEY_PASSWORD = "$env:SECRET_PFX_PASSWORD"

# electron-builder automatically invokes signtool during build
npm run dist
```

### Option B: Azure Trusted Signing (Microsoft Recommended)
For enterprise cloud-managed signing:
```powershell
signtool sign /v /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 /dlib "path\to\Azure.CodeSigning.Dlib.dll" /dmdf "path\to\metadata.json" dist\BARQ-Downloader-Setup-0.1.0.exe
```

### Option C: Signature Verification Audit
Verify the Authenticode signature prior to distribution:
```powershell
Get-AuthenticodeSignature dist/BARQ-Downloader-Setup-0.1.0.exe
# Production build must return: Status = Valid
```

---

## 4. DISTRIBUTION & RELEASE PUBLISHING

- [ ] Tag the release commit in Git:
  ```powershell
  git tag -a v0.1.0 -m "Release v0.1.0: BARQ Downloader Initial Production Release"
  git push origin v0.1.0
  ```
- [ ] Create a GitHub / GitLab Release attached to tag `v0.1.0`.
- [ ] Upload the following release assets:
  1. `BARQ-Downloader-Setup-0.1.0.exe`
  2. `BARQ-Downloader-Portable-0.1.0.exe`
  3. `SHA256SUMS.txt`
  4. `WINDOWS_INSTALLATION_GUIDE.md`
- [ ] Publish release notes highlighting:
  - Multi-segment parallel acceleration (8 connections).
  - Chrome & Edge browser extension integration.
  - Modern desktop dashboard.
  - Robust crash and interrupted download recovery.

---

## 5. POST-RELEASE SMOKE & ROLLBACK PLAN

### Post-Release Smoke Check
1. Download `BARQ-Downloader-Setup-0.1.0.exe` from the public release page onto a clean Windows 10/11 test machine.
2. Verify checksum:
   `Get-FileHash .\BARQ-Downloader-Setup-0.1.0.exe -Algorithm SHA256`
3. Run the installer, launch the app, and complete a test download.
4. Verify browser extension connects via Native Messaging.

### Rollback Procedure
If a critical packaging defect or crash issue is reported post-release:
1. Mark the GitHub release as **Pre-release** or archive it.
2. Post an advisory recommending users revert to the prior stable release or portable build.
3. Because user data is stored safely in `%LOCALAPPDATA%\BARQ Downloader\barq.db`, installing an earlier or patched build will **not lose user downloads or history**.
