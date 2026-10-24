@echo off
title XunWu ZhiLian - Local Server
cd /d "%~dp0"
echo ============================================
echo   XunWu ZhiLian (Lost and Found) Launcher
echo ============================================
echo.

rem ---------- 1) Check Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed on this computer.
  echo.
  echo Please install Node.js LTS version from:
  echo     https://nodejs.org
  echo.
  echo After installation, double-click this file again.
  echo.
  pause
  exit /b 1
)

rem ---------- 2) Make sure dependencies (incl. native module) are usable ----------
node -e "require('better-sqlite3')" 2>nul
if errorlevel 1 (
  echo First run on this computer: installing dependencies...
  echo This needs an internet connection and may take a minute or two.
  echo.
  call npm install
  echo.
)
node -e "require('better-sqlite3')" 2>nul
if errorlevel 1 (
  echo [ERROR] Dependencies failed to install or load.
  echo Please make sure you have internet access, then double-click again.
  echo.
  pause
  exit /b 1
)

rem ---------- 3) If the server is already running, just open the browser ----------
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo Service is already running. Opening browser...
  start "" http://localhost:3000
  goto end
)

rem ---------- 4) Start the server in a new window, wait, then open browser ----------
echo Starting local server...
start "XunWu Server" /D "%~dp0" cmd /k node server.js

echo Waiting for the server to become ready...
set /a tries=0
:wait
timeout /t 1 /nobreak >nul
set /a tries+=1
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo.
  echo ==================================================
  echo  Server is ready. Opening browser...
  echo  Keep the black "XunWu Server" window open while using the site.
  echo ==================================================
  start "" http://localhost:3000
  goto end
)
if %tries% lss 30 goto wait

echo.
echo [ERROR] Server failed to start within 30 seconds.
echo If port 3000 is in use by another program, close it and try again.
echo.
pause
:end
