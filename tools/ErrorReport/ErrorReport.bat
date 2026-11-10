@echo off
title EvEJS - Error Report
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0error-report.ps1" %*
echo.
pause
