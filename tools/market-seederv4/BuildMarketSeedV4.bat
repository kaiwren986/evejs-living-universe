@echo off
setlocal
call "%~dp0..\market-seederv2\BuildMarketSeedV2.bat" iron-man %*
exit /b %errorlevel%
