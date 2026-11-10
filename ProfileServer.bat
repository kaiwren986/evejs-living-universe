@echo off
setlocal
title EvEJS - Profile Server
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 24 LTS is required. Run SetupEveJS.bat first.
  pause
  exit /b 1
)
node "%~dp0tools\ErrorReport\profile-server.js" %*
set "EVEJS_PROFILE_EXIT=%errorlevel%"
echo.
pause
exit /b %EVEJS_PROFILE_EXIT%
