@echo off
setlocal
cd /d "%~dp0"
node tools\ContentPacks\index.js %*
exit /b %errorlevel%
