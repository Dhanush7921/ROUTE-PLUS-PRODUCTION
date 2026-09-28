@echo off
REM ROUTE+ - push the production package to GitHub.
REM Usage:  PUSH-TO-GITHUB.cmd https://github.com/<owner>/<repo>.git
setlocal
cd /d "%~dp0"

if "%~1"=="" (
  echo.
  echo   Pass your GitHub repository URL, for example:
  echo     PUSH-TO-GITHUB.cmd https://github.com/yourname/route-plus.git
  echo.
  pause
  exit /b 1
)

where git >nul 2>&1 || (echo   Git is not on PATH. Install Git for Windows, then run this again. & pause & exit /b 1)

echo   Repository state before pushing:
git status --short --branch
echo.
echo   Nothing below should list .env or a .sqlite file:
git ls-files ^| findstr /i ".env .sqlite"
echo   ^(no output above = clean^)
echo.

git remote remove origin 2>nul
git remote add origin %~1 || (echo   Could not set origin. & pause & exit /b 1)
echo   origin -^> %~1
echo.

git push -u origin main
if errorlevel 1 (
  echo.
  echo   Push failed. Most common causes:
  echo     - not signed in: a browser or credential prompt should appear; approve it
  echo     - wrong URL, or the repository is private and this account cannot write to it
  echo     - the repository is not empty: run  git pull --rebase origin main  then push again
  pause
  exit /b 1
)

echo.
echo   Pushed. Verifying:
git remote -v
git branch -vv
git log --oneline -1
echo.
pause
