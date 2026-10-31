# BARQ Downloader — Unregister Native Messaging Host Script

$ErrorActionPreference = "SilentlyContinue"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " BARQ Downloader — Native Messaging Host Unregistration" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$ChromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.barq.downloader"
$EdgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.barq.downloader"

if (Test-Path $ChromeRegPath) {
    Remove-Item -Path $ChromeRegPath -Recurse -Force
    Write-Host "[OK] Removed Google Chrome registration: $ChromeRegPath" -ForegroundColor Green
} else {
    Write-Host "[INFO] Chrome registration not found." -ForegroundColor Gray
}

if (Test-Path $EdgeRegPath) {
    Remove-Item -Path $EdgeRegPath -Recurse -Force
    Write-Host "[OK] Removed Microsoft Edge registration: $EdgeRegPath" -ForegroundColor Green
} else {
    Write-Host "[INFO] Edge registration not found." -ForegroundColor Gray
}

Write-Host ""
Write-Host "Unregistration complete." -ForegroundColor Green
