@echo off
setlocal
title EvEJS - Reset All Player Missions

for %%I in ("%~dp0..\..") do set "EVEJS_REPO_ROOT=%%~fI"
set "EVEJS_RESET_PS1=%~dp0Reset-AllPlayerMissions.ps1"

if not exist "%EVEJS_RESET_PS1%" (
  echo.
  echo   [ERROR] Mission-reset script not found:
  echo       %EVEJS_RESET_PS1%
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_RESET_PS1%" %*
set "EVEJS_RESET_EXIT=%errorlevel%"

echo.
if not "%EVEJS_RESET_EXIT%"=="0" (
  echo   Mission reset did not complete. Read the error above; no successful
  echo   reset was reported.
)

for %%A in (%*) do if /I "%%~A"=="-Yes" exit /b %EVEJS_RESET_EXIT%
pause
exit /b %EVEJS_RESET_EXIT%
