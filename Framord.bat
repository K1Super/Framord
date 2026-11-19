@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Electron runtime not found.
  echo Run: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0
