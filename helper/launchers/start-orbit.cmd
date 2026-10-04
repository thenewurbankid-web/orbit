@echo off
rem Start Orbit (Windows). Double-click it.
rem Finds Node.js (Paperclip runs on it, so it is on this computer), then sets Orbit up: copies it to
rem %LOCALAPPDATA%\Orbit, starts it at login (no admin), starts it now and opens the Orbit page.
setlocal EnableExtensions
title Orbit
cd /d "%~dp0"
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE call :try "%%i"
if not defined NODE for /f "delims=" %%i in ('powershell -NoProfile -Command "$f = Get-ChildItem -ErrorAction SilentlyContinue $env:USERPROFILE\.local\bin\paperclipai*; if ($f) { (Select-String -Path $f.FullName -Pattern '[A-Za-z]:\\[^''\"]*node\.exe' | Select-Object -First 1).Matches[0].Value }" 2^>nul') do if not defined NODE call :try "%%i"
if not defined NODE call :try "%ProgramFiles%\nodejs\node.exe"
if not defined NODE call :try "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE if defined NVM_SYMLINK call :try "%NVM_SYMLINK%\node.exe"
if not defined NODE call :try "%LOCALAPPDATA%\Volta\bin\node.exe"
if not defined NODE call :try "%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE (
  echo.
  echo Orbit needs Node.js 20 or newer, and it isn't on this computer yet.
  echo Install it from https://nodejs.org ^(the LTS button^), then open Start Orbit again.
  echo.
  pause
  exit /b 1
)
"%NODE%" "%~dp0helper\setup.mjs" %*
echo.
pause
exit /b

:try
if not exist "%~1" exit /b
"%~1" -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" >nul 2>&1 && set "NODE=%~1"
exit /b
