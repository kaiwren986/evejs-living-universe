@echo off
rem Play.bat with the EVE client's own debug console: the client starts with
rem /console and writes to that window instead of the client stdio log file.
rem Every setup check, endpoint, proxy rule and diagnostic is Play.bat's.
setlocal
set "ERRORLEVEL="
set "EVEJS_CLIENT_DEBUG=1"
call "%~dp0Play.bat" %*
exit /b %errorlevel%
