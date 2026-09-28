@echo off
title ROUTE+ production server
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo.
echo   ROUTE+ - starting the production server
echo   =======================================
echo.

REM --- Node check -------------------------------------------------------
where node >nul 2>&1
if errorlevel 1 (
  echo   Node.js was not found on PATH.
  echo   Install Node.js 22.13 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%v in ('node -v') do set NODEV=%%v
echo   Node %NODEV%

REM --- Data directory: local disk, outside this folder -------------------
if not exist "C:\routeplus-data" mkdir "C:\routeplus-data"

REM --- .env: created once, then yours to edit ----------------------------
if not exist ".env" (
  echo   Creating .env ...
  > .env echo NODE_ENV=production
  >> .env echo PORT=8080
  >> .env echo HOST=0.0.0.0
  >> .env echo ROUTE_PLUS_DB=C:\routeplus-data\routeplus.sqlite
  >> .env echo ADMIN_EMAILS=spamlogin82@gmail.com
  >> .env echo ROUTE_PLUS_CONTACT=spamlogin82@gmail.com
  >> .env echo LOG_LEVEL=info
)

REM --- Where to reach it -------------------------------------------------
echo.
echo   This computer:  http://localhost:8080
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
  set IP=%%a
  set IP=!IP: =!
  echo   On your Wi-Fi:  http://!IP!:8080      ^<-- use this in the Android app
)
echo   Health check:   http://localhost:8080/api/health
echo   Admin:          http://localhost:8080/admin.html
echo.
echo   Leave this window open. Press Ctrl+C to stop the server.
echo.

node --env-file-if-exists=.env --disable-warning=ExperimentalWarning server\index.js

echo.
echo   ROUTE+ stopped.
pause
