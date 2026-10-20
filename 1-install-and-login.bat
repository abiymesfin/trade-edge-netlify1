@echo off
cd /d "%~dp0"
echo Installing project dependencies...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed.
  pause
  exit /b 1
)
echo.
echo Logging in to Netlify...
call npx netlify-cli login
pause
