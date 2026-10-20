@echo off
cd /d "%~dp0"
echo.
echo Installing project dependencies required by Netlify Functions...
call npm install
if errorlevel 1 (
  echo.
  echo npm install failed. Deployment stopped.
  pause
  exit /b 1
)
echo.
echo Deploying Trade Edge to Netlify...
call npx netlify-cli deploy --prod
pause
