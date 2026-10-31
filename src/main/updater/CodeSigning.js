'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';

class CodeSigning {
  /**
   * Evaluates environment configuration for Authenticode code signing.
   * @returns {{ enabled: boolean, certConfigured: boolean, timestampUrl: string, status: string }}
   */
  static getSigningStatus() {
    const enabled = process.env.BARQ_SIGNING_ENABLED === '1' || process.env.BARQ_SIGNING_ENABLED === 'true';
    const certPath = process.env.BARQ_SIGNING_CERT || null;
    const certExists = certPath ? fs.existsSync(certPath) : false;

    let status = 'unsigned_development';
    if (enabled && certExists) {
      status = 'signed_production';
    } else if (certPath && !certExists) {
      status = 'cert_missing_error';
    } else if (enabled && !certPath) {
      status = 'signing_enabled_no_cert';
    }

    return {
      enabled,
      certConfigured: Boolean(certExists),
      certPath: certExists ? certPath : null,
      timestampUrl: process.env.BARQ_SIGNING_TIMESTAMP_URL || DEFAULT_TIMESTAMP_URL,
      status,
    };
  }

  /**
   * Verifies Authenticode digital signature on a Windows executable.
   * Uses PowerShell Get-AuthenticodeSignature or signtool verify.
   * @param {string} filePath
   * @returns {{ signed: boolean, status: string, signerCertificate?: string, error?: string }}
   */
  static verifyFileSignature(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
      return { signed: false, status: 'FILE_NOT_FOUND', error: `File not found: ${filePath}` };
    }

    if (process.platform !== 'win32') {
      return { signed: false, status: 'NOT_WINDOWS', error: 'Authenticode verification is Windows-only.' };
    }

    try {
      // Execute PowerShell Get-AuthenticodeSignature
      const script = `
        $sig = Get-AuthenticodeSignature -LiteralPath '${filePath.replace(/'/g, "''")}';
        @{
          Status = $sig.Status.ToString();
          StatusMessage = $sig.StatusMessage;
          IsOSBinary = $sig.IsOSBinary;
          Subject = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { $null };
          Thumbprint = if ($sig.SignerCertificate) { $sig.SignerCertificate.Thumbprint } else { $null };
        } | ConvertTo-Json -Compress
      `;

      const stdout = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 15000,
      });

      const parsed = JSON.parse(stdout.trim());
      const isSigned = parsed.Status === 'Valid';

      return {
        signed: isSigned,
        status: parsed.Status,
        statusMessage: parsed.StatusMessage,
        subject: parsed.Subject,
        thumbprint: parsed.Thumbprint,
        error: isSigned ? null : `Signature status is ${parsed.Status}`,
      };
    } catch (err) {
      return {
        signed: false,
        status: 'VERIFICATION_ERROR',
        error: `Authenticode check failed: ${err.message}`,
      };
    }
  }

  /**
   * Signs a Windows executable using signtool.exe if signing is configured.
   * @param {string} targetPath File to sign
   * @param {object} [opts]
   * @returns {{ success: boolean, skipped?: boolean, reason?: string, error?: string }}
   */
  static signFile(targetPath, opts = {}) {
    const config = this.getSigningStatus();
    if (!config.enabled || !config.certConfigured) {
      return {
        success: true,
        skipped: true,
        reason: 'Signing disabled or certificate not configured. File left as unsigned build.',
      };
    }

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Target file to sign not found: ${targetPath}`);
    }

    const certPath = config.certPath;
    const certPassword = process.env.BARQ_SIGNING_CERT_PASSWORD || '';
    const timestampUrl = config.timestampUrl;

    const args = [
      'sign',
      '/fd', 'sha256',
      '/tr', timestampUrl,
      '/td', 'sha256',
      '/f', certPath,
    ];

    if (certPassword) {
      args.push('/p', certPassword);
    }

    args.push(targetPath);

    try {
      execFileSync('signtool.exe', args, {
        encoding: 'utf8',
        timeout: 30000,
      });

      // Verify immediately after signing
      const verifyResult = this.verifyFileSignature(targetPath);
      if (!verifyResult.signed) {
        throw new Error(`Signature verification failed immediately after signing: ${verifyResult.error}`);
      }

      return { success: true, verified: true };
    } catch (err) {
      throw new Error(`Authenticode signing failed for ${path.basename(targetPath)}: ${err.message}`);
    }
  }
}

module.exports = { CodeSigning, DEFAULT_TIMESTAMP_URL };
