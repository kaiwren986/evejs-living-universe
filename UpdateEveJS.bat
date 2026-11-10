@echo off
setlocal EnableDelayedExpansion
title EvEJS - Update

rem Opens the updater window: install a new release over this folder, or install
rem a content pack. It keeps the game database, settings, certificates and the
rem launcher config, and moves the old program files to _backup instead of
rem deleting them.
rem
rem Deliberately a PowerShell script rather than a Node script, for the same
rem reason SetupEveJS.bat is: Docker users do not need Node.js installed, and
rem this has to be able to run on a broken or half-installed copy.
rem
rem This file also works when copied out of the folder along with
rem Update-EvEJS.ps1 and update-policy.json, which is how the updater is handed
rem to someone whose installation predates it.

set "EVEJS_UPDATER_PS1="
if exist "%~dp0Update-EvEJS.ps1" set "EVEJS_UPDATER_PS1=%~dp0Update-EvEJS.ps1"
if not defined EVEJS_UPDATER_PS1 if exist "%~dp0tools\Updater\Update-EvEJS.ps1" set "EVEJS_UPDATER_PS1=%~dp0tools\Updater\Update-EvEJS.ps1"

if not defined EVEJS_UPDATER_PS1 (
  echo.
  echo   [ERROR] Update-EvEJS.ps1 was not found.
  echo       Expected it beside this file, or in tools\Updater.
  echo.
  pause
  exit /b 1
)

rem /console keeps the console window visible behind the updater window. It
rem normally hides itself once that window is up; support asks for /console when
rem a run fails before that happens. Every other argument is passed straight
rem through to the script.
set "EVEJS_UPDATER_ARGS=%*"
if /I "%~1"=="/console" set "EVEJS_UPDATER_ARGS=-KeepConsole"

powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_UPDATER_PS1%" %EVEJS_UPDATER_ARGS%
set "EVEJS_UPDATER_EXIT=%errorlevel%"

if not "%EVEJS_UPDATER_EXIT%"=="0" (
  echo.
  echo   The updater exited with code %EVEJS_UPDATER_EXIT%.
  echo   Nothing was left half-updated: a failed update puts the old files back.
  echo.
  pause
)

exit /b %EVEJS_UPDATER_EXIT%
