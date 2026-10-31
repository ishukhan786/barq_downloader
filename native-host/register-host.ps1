# BARQ Downloader — Chrome & Microsoft Edge Native Messaging Host Registration Script
# Registers the Native Host in HKCU for the current Windows user (no admin rights required).

param (
    [string]$ExtensionId = "gnbkgloidbhnmbllllgaflmblimmhgli"
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$HostBatPath = Join-Path $ScriptDir "barq-native-host.bat"
$ManifestPath = Join-Path $ScriptDir "com.barq.downloader.json"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " BARQ Downloader — Native Messaging Host Registration" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Validate launcher existence
if (-not (Test-Path $HostBatPath)) {
    Write-Error "Launcher bat not found at: $HostBatPath"
    exit 1
}

# 2. Update Manifest with absolute path and allowed extension origins
$Origins = @(
    "chrome-extension://$ExtensionId/",
    "extension://$ExtensionId/"
)

$ManifestObj = [PSCustomObject]@{
    name = "com.barq.downloader"
    description = "BARQ Downloader Native Messaging Host"
    path = $HostBatPath
    type = "stdio"
    allowed_origins = $Origins
}

$ManifestJson = $ManifestObj | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, [System.Text.Encoding]::UTF8)
Write-Host "[OK] Native Host Manifest written to: $ManifestPath" -ForegroundColor Green

# 3. Register for Google Chrome in HKCU
$ChromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.barq.downloader"
if (-not (Test-Path $ChromeRegPath)) {
    New-Item -Path $ChromeRegPath -Force | Out-Null
}
Set-ItemProperty -Path $ChromeRegPath -Name "(Default)" -Value $ManifestPath
Write-Host "[OK] Registered for Google Chrome at: $ChromeRegPath" -ForegroundColor Green

# 4. Register for Microsoft Edge in HKCU
$EdgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.barq.downloader"
if (-not (Test-Path $EdgeRegPath)) {
    New-Item -Path $EdgeRegPath -Force | Out-Null
}
Set-ItemProperty -Path $EdgeRegPath -Name "(Default)" -Value $ManifestPath
Write-Host "[OK] Registered for Microsoft Edge at: $EdgeRegPath" -ForegroundColor Green

Write-Host ""
Write-Host "Registration successful!" -ForegroundColor Green
Write-Host "Extension ID configured: $ExtensionId" -ForegroundColor Yellow
