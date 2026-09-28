@echo off
REM ROUTE+ production start (Windows). Needs Node.js 22.13 or newer.
setlocal
cd /d "%~dp0"
if not exist ".env" (
  echo   No .env found. Copy .env.production.example to .env and edit it first.
  exit /b 1
)
echo   Validating configuration and walking every beta flow...
call npm.cmd run check:beta || (echo   check:beta FAILED — not starting. & exit /b 1)
echo.
echo   Starting ROUTE+ ...
node --env-file-if-exists=.env --disable-warning=ExperimentalWarning server/index.js
