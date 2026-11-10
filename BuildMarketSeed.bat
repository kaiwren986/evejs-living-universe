@echo off
setlocal
title EvEJS - Choose Market Seed

if /i "%~1"=="v1" goto V1
if /i "%~1"=="v2" goto V2
if /i "%~1"=="v3" goto V3
if /i "%~1"=="v4" goto V4
if /i "%~1"=="help" goto Help
if /i "%~1"=="--help" goto Help
if not "%~1"=="" (
  echo Unknown seed type: %~1. Expected v1, v2, v3 or v4.
  exit /b 2
)

call :ShowSeeds
choice /c 1234 /n /m "  Choose a market seed [1-4]: "
if errorlevel 5 exit /b 2
if errorlevel 4 goto V4
if errorlevel 3 goto V3
if errorlevel 2 goto V2
if errorlevel 1 goto V1
exit /b 0

:V1
call "%~dp0tools\market-seed\BuildMarketSeedGui.bat"
exit /b %errorlevel%

:V2
call "%~dp0tools\market-seederv2\BuildMarketSeedV2.bat"
exit /b %errorlevel%

:V3
call "%~dp0tools\market-seederv3\BuildMarketSeedV3.bat"
exit /b %errorlevel%

:V4
call "%~dp0tools\market-seederv4\BuildMarketSeedV4.bat"
exit /b %errorlevel%

:Help
call :ShowSeeds
echo   Usage: BuildMarketSeed.bat [v1^|v2^|v3^|v4]
exit /b 0

:ShowSeeds
echo.
echo   EvEJS - Choose Market Seed
echo.
echo     [1] v1 - Synthetic starter market ^(recommended^)
echo         Offline prices from static data; Jita + New Caldari or wider presets.
echo     [2] v2 - Tranquility snapshot
echo         Real station prices and quantities; Jita plus NPC stock by default.
echo     [3] v3 - Cost-priced Jita hub + NPC catalog
echo         Ships, modules and materials at build-cost prices; authentic NPC stock.
echo     [4] v4 - Iron Man
echo         NPC stock only: BPOs, skillbooks, command centers and trade goods.
echo         Players obtain everything else through gameplay and industry.
echo.
echo   Each option opens its builder. All use the same market database.
echo.
exit /b 0
