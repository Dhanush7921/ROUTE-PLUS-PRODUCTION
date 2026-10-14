@echo off
REM ============================================================================
REM ROUTE+ — install a nightly database backup as a Windows Scheduled Task,
REM and verify a restore immediately so "backups work" is evidence, not hope.
REM
REM Run ONCE, as Administrator, from the project root:
REM     cd C:\Users\Asus\Documents\ROUTE+\ROUTE_PLUS_PRODUCTION
REM     SCHEDULE-BACKUPS.cmd
REM
REM What it does:
REM   1. takes a backup now, through the project's own tooling
REM   2. verifies it by restoring into a DISPOSABLE database and comparing
REM      row counts against the backup's manifest — never over production
REM   3. registers a scheduled task that repeats step 1 every night at 02:14
REM
REM Both commands follow ROUTE_PLUS_DB_MODE, so this covers whichever backend
REM is live: VACUUM INTO for SQLite, pg_dump --format=custom for PostgreSQL.
REM
REM Backups land in .\backups\ , which .gitignore already excludes along with
REM *.dump and *.dump.json. Nothing here prints or stores a credential: the
REM database password is read from .env by the scripts themselves and passed to
REM pg_dump through its environment, never on a command line.
REM ============================================================================
setlocal

set ROOT=%~dp0
set ROOT=%ROOT:~0,-1%
cd /d "%ROOT%" || (echo   Cannot enter %ROOT% & pause & exit /b 1)

if not exist "package.json" (
  echo   Run this from ROUTE_PLUS_PRODUCTION ^(no package.json here^).
  pause & exit /b 1
)

echo.
echo ===== 1. Backup now ======================================================
call npm run db:backup
if errorlevel 1 (
  echo.
  echo   The backup failed, so there is nothing to schedule yet.
  echo   Exit code 3 means pg_dump is not on PATH. PostgreSQL only lives in
  echo   Docker on this machine, so point at the client binaries instead —
  echo   add these to .env and re-run:
  echo       PG_DUMP=C:\Program Files\PostgreSQL\16\bin\pg_dump.exe
  echo       PG_RESTORE=C:\Program Files\PostgreSQL\16\bin\pg_restore.exe
  echo   ...or run the backup inside the container:
  echo       docker exec -t ^<pg-container^> pg_dump -Fc -U routeplus routeplus ^> backup.dump
  pause & exit /b 1
)

echo.
echo ===== 2. Verify it by restoring into a disposable database ===============
call npm run db:restore:verify
if errorlevel 1 (
  echo.
  echo   The restore check FAILED. Do not rely on these backups until it
  echo   passes — a backup that will not restore is not a backup.
  pause & exit /b 1
)

echo.
echo ===== 3. Register the nightly task ======================================
REM 02:14 rather than 02:00: most schedulers fire on the hour, and a backup
REM that competes with everything else on the machine is the one that fails.
schtasks /Query /TN "ROUTE+ nightly database backup" >nul 2>&1 && (
  echo   Task already exists — replacing it.
  schtasks /Delete /TN "ROUTE+ nightly database backup" /F >nul
)
schtasks /Create ^
  /TN "ROUTE+ nightly database backup" ^
  /TR "cmd /c cd /d \"%ROOT%\" && npm run db:backup >> \"%ROOT%\\backups\\backup.log\" 2>&1" ^
  /SC DAILY /ST 02:14 /RL HIGHEST /F
if errorlevel 1 (
  echo.
  echo   Could not register the task. Re-run this file as Administrator
  echo   ^(right-click -^> Run as administrator^).
  pause & exit /b 1
)

echo.
echo ===== Done ===============================================================
schtasks /Query /TN "ROUTE+ nightly database backup" /FO LIST | findstr /C:"TaskName" /C:"Next Run Time" /C:"Status"
echo.
echo   Backups:        %ROOT%\backups\
echo   Nightly log:    %ROOT%\backups\backup.log
echo   Verify anytime: npm run db:restore:verify
echo.
echo   TWO THINGS THIS DOES NOT DO:
echo     - it does not copy backups OFF this machine. A backup on the same
echo       disk as the database does not survive losing the disk. Point
echo       OneDrive/rclone at the backups folder, or run
REM         npm run db:backup -- D:\some\other\drive
echo       npm run db:backup -- ^<another drive or share^>
echo     - it does not verify the nightly runs. Run the restore check
echo       yourself about as often as you would mind losing a day of data.
echo.
pause
