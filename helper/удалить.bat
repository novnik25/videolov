@echo off
rem ASCII-only on purpose, see установить.bat
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found.
  pause
  exit /b 1
)
node "%~dp0uninstall.js"
echo.
pause
