@echo off
rem ASCII-only: Windows reads .bat in the OEM codepage, Cyrillic here turns to mush.
rem Russian text is printed by install.js; chcp 65001 makes the console show it.
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)
node "%~dp0install.js"
echo.
pause
