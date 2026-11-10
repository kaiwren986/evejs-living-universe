@echo off
setlocal EnableDelayedExpansion
title EveJS RPG

rem EveJS RPG fork: one double-click to play.
rem Starts, each in its own minimized window and only if it is not already
rem running: the local AI (LM Studio, see config\llm.json), the market server
rem and the game server. Then waits for the server and launches EVE through
rem Play.bat, which also installs the client mod hook. Close the minimized
rem windows to stop the servers.

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "PS=powershell -NoProfile -ExecutionPolicy Bypass"

echo.
echo   ============================================================
echo     EveJS RPG
echo   ============================================================
echo.

echo   [1/4] Local AI
start "EveJS Local AI" /min %PS% -File "%ROOT%\tools\LocalAI\Start-LocalAI.ps1" -Wait

echo   [2/4] Market server
call :PortOpen 40111
if errorlevel 1 (
  start "EveJS Market Server" /min %PS% -File "%ROOT%\externalservices\market-server\StartMarketServer.ps1" -Mode serve-release
  echo         starting...
) else (
  echo         already running.
)

echo   [3/4] Game server
call :PortOpen 26000
if errorlevel 1 (
  start "EveJS Server" /min cmd /c ""%ROOT%\StartServer.bat" < "%ROOT%\tools\RPG\server-only.txt""
  echo         starting, this takes a minute...
) else (
  echo         already running.
)

call :WaitForServer
if errorlevel 1 (
  echo.
  echo   [ERROR] The game server did not come up within 5 minutes.
  echo       Open the "EveJS Server" window on the taskbar to see why.
  pause
  exit /b 1
)

echo   [4/4] EVE
call "%ROOT%\Play.bat"
exit /b %errorlevel%

:PortOpen
netstat -an | findstr /R /C:"127\.0\.0\.1:%1 .*LISTENING" >nul 2>&1
exit /b %errorlevel%

:WaitForServer
for /L %%N in (1,1,150) do (
  call :PortOpen 26000
  if not errorlevel 1 (
    %PS% -Command "try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:26002/health').StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
    if not errorlevel 1 (
      echo         game server is ready.
      exit /b 0
    )
  )
  ping -n 3 127.0.0.1 >nul 2>&1
)
exit /b 1
