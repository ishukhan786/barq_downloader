@echo off
setlocal
set "HOST_DIR=%~dp0"

:: 1. If running inside a packaged app, prefer the bundled Electron executable as Node runtime
if exist "%HOST_DIR%..\..\BARQ Downloader.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HOST_DIR%..\..\BARQ Downloader.exe" "%HOST_DIR%barq-native-host.js" %*
  exit /b %ERRORLEVEL%
)

if exist "%HOST_DIR%..\BARQ Downloader.exe" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%HOST_DIR%..\BARQ Downloader.exe" "%HOST_DIR%barq-native-host.js" %*
  exit /b %ERRORLEVEL%
)

:: 2. Fallback to system node
node "%HOST_DIR%barq-native-host.js" %*
exit /b %ERRORLEVEL%
