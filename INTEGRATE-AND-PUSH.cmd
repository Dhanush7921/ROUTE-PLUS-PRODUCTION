@echo off
REM ============================================================================
REM ROUTE+ — safely integrate origin/main and push.
REM
REM Run this from the project root:
REM     cd C:\Users\Asus\Documents\ROUTE+\ROUTE_PLUS_PRODUCTION
REM     INTEGRATE-AND-PUSH.cmd
REM
REM Why this script exists: the remote already has its own initial commit
REM (4202a9a9), the local repo has the full ROUTE+ implementation (5f37176),
REM and the two histories may be unrelated. This walks the integration in the
REM order that cannot lose work, SHOWS you what is about to happen, and stops
REM for your confirmation before the merge and again before the push.
REM
REM It never runs: git reset --hard, git clean, git checkout -- ., or any force
REM push. If anything fails it stops and leaves the repository as it was.
REM
REM Your history is already backed up as a verified git bundle at:
REM     C:\Users\Asus\Documents\ROUTE+\_backup\ROUTE_PLUS-local-*.bundle
REM To recover from it:  git clone <that-bundle> recovered-route-plus
REM ============================================================================
setlocal EnableDelayedExpansion

if not exist ".git" (
  echo   Not a git repository. Run this from ROUTE_PLUS_PRODUCTION.
  pause & exit /b 1
)

echo.
echo ===== 0. Clear any stale lock left by an interrupted git command ==========
if exist ".git\index.lock" del ".git\index.lock"
for %%L in (".git\*.lock") do del "%%L" 2>nul

echo.
echo ===== 1. Where we are ====================================================
git rev-parse --abbrev-ref HEAD
git log --oneline -3
git status --short
for /f %%i in ('git status --porcelain ^| find /c /v ""') do set DIRTY=%%i
if not "!DIRTY!"=="0" (
  echo.
  echo   You have !DIRTY! uncommitted change^(s^). Commit or stash them first —
  echo   this script will not merge over a dirty working tree.
  pause & exit /b 1
)

echo.
echo ===== 2. Fetch the remote ================================================
git remote -v
git fetch origin main || (echo   Fetch failed — check your GitHub sign-in. & pause & exit /b 1)

echo.
echo ===== 3. Both histories ==================================================
echo --- local main:
git log --oneline main
echo --- origin/main:
git log --oneline origin/main
echo.
echo --- files the remote has that local does not:
git diff --name-status main origin/main

echo.
echo ===== 4. Are the histories related? =====================================
set MERGEBASE=
for /f %%b in ('git merge-base main origin/main 2^>nul') do set MERGEBASE=%%b
if "!MERGEBASE!"=="" (
  echo   NO common ancestor — the histories are UNRELATED.
  echo   The merge below therefore needs --allow-unrelated-histories.
  set UNRELATED=1
) else (
  echo   Common ancestor: !MERGEBASE!
  set UNRELATED=0
)

echo.
echo --- what is actually IN the remote commit (inspect before merging):
git ls-tree -r --name-only origin/main

echo.
echo ==========================================================================
echo   About to merge origin/main into local main.
echo   Local work is preserved: a merge adds the remote's commit alongside
echo   yours, it does not replace anything. Conflicts stop the merge and
echo   leave both sides intact for you to resolve.
echo ==========================================================================
choice /C YN /M "Proceed with the merge"
if errorlevel 2 (echo   Stopped. Nothing changed. & pause & exit /b 0)

echo.
echo ===== 5. Merge ===========================================================
if "!UNRELATED!"=="1" (
  git merge --no-ff --allow-unrelated-histories -m "Integrate origin/main into the ROUTE+ production history" origin/main
) else (
  git merge --no-ff -m "Integrate origin/main into the ROUTE+ production history" origin/main
)
if errorlevel 1 (
  echo.
  echo   The merge stopped — almost certainly a conflict. Nothing is lost.
  echo   Inspect with:   git status
  echo   Resolve a file, then:   git add ^<file^>
  echo   When all are resolved:  git commit
  echo   To abandon the merge and go back:   git merge --abort
  pause & exit /b 1
)
echo   Merged.

echo.
echo ===== 6. Secret and junk scan on TRACKED files ===========================
set BAD=0
for %%F in (.env .env.production .env.local) do (
  git ls-files --error-unmatch %%F >nul 2>&1 && (echo   TRACKED SECRET: %%F & set BAD=1)
)
git ls-files | findstr /R /C:"\.sqlite" /C:"\.dump" /C:"^data/" /C:"^backups/" >nul 2>&1 && (
  echo   TRACKED DATABASE OR BACKUP FILES: & git ls-files ^| findstr /R /C:"\.sqlite" /C:"\.dump" /C:"^data/" /C:"^backups/" & set BAD=1
)
if not "!BAD!"=="0" (
  echo.
  echo   Refusing to push: something private is tracked. Remove it with
  echo   "git rm --cached ^<file^>", commit, then re-run.
  pause & exit /b 1
)
echo   Clean: no .env, no databases, no dumps, no backups tracked.
echo   (.env.example is tracked on purpose — placeholders only, no credentials.)

echo.
echo ===== 7. Whitespace and tests ===========================================
git diff --check
echo --- npm test (PostgreSQL tests skip unless ROUTE_PLUS_PG_TEST_URL is set):
call npm test || (echo   Tests failed — not pushing. & pause & exit /b 1)

echo.
echo ===== 8. Confirm the merged history contains BOTH lines of work ==========
git log --oneline --graph -12
echo.
echo   You should see your ROUTE+ commits AND the remote's commit above.
choice /C YN /M "Does the history look right - push it"
if errorlevel 2 (echo   Stopped. The merge is committed locally; nothing pushed. & pause & exit /b 0)

echo.
echo ===== 9. Push (ordinary push, never forced) =============================
git push -u origin main || (
  echo.
  echo   Push failed. Nothing local was lost. Common causes:
  echo     - not signed in to GitHub: run "git credential-manager github login"
  echo       or push once from GitHub Desktop / VS Code to store the credential
  echo     - the remote moved again: re-run this script to fetch and merge
  pause & exit /b 1
)

echo.
echo ===== 10. Verify the push ================================================
git fetch origin main
echo --- local main:
git rev-parse main
echo --- origin/main:
git rev-parse origin/main
git log --oneline -1 origin/main
echo.
echo   If those two SHAs match, the push is confirmed.
echo.
pause
