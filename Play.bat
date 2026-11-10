@echo off
setlocal EnableDelayedExpansion
set "ERRORLEVEL="

rem PlayDebug.bat sets EVEJS_CLIENT_DEBUG=1. The client then starts with /console
rem and writes to its own console window instead of the client stdio log file.
rem Set with one-line ifs: a ")" in these values would close a ( ) block.
set "EVEJS_LAUNCHER_NAME=Play.bat"
set "EVEJS_LAUNCH_LABEL="
set "EVEJS_CLIENT_CONSOLE_ARG="
set "EVEJS_SUPPORT_HINT=the client stdio log if Play.bat prints one after exit"
if "%EVEJS_CLIENT_DEBUG%"=="1" set "EVEJS_LAUNCHER_NAME=PlayDebug.bat"
if "%EVEJS_CLIENT_DEBUG%"=="1" set "EVEJS_LAUNCH_LABEL= (Debug Console)"
if "%EVEJS_CLIENT_DEBUG%"=="1" set "EVEJS_CLIENT_CONSOLE_ARG=/console "
if "%EVEJS_CLIENT_DEBUG%"=="1" set "EVEJS_SUPPORT_HINT=any debug-console exception text"
title EveJS Elysian - Play%EVEJS_LAUNCH_LABEL%


rem Resolve the launcher root from this script's location.
for %%I in ("%~dp0.") do set "EVEJS_REPO_ROOT=%%~fI"


rem Load config from the new location first, then older layouts.
call :ResolveConfigDir
if not "!errorlevel!"=="0" exit /b 1
call "%EVEJS_CONFIG_DIR%\EvEJSConfig.bat"
set "ERRORLEVEL="
if not "!errorlevel!"=="0" (
  echo.
  echo   [ERROR] Could not load launcher config:
  echo       %EVEJS_CONFIG_DIR%\EvEJSConfig.bat
  pause
  exit /b 1
)
call :ResolveServerEndpoints
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

echo.
echo   ============================================================
echo     EveJS Elysian - Play%EVEJS_LAUNCH_LABEL%
echo   ============================================================
echo.


rem The CA is in the data root's certs folder: EVEJS_DATA_ROOT\certs, else _local\certs.
rem Launcher settings made before 2026-09-21 name server\certs, where it used to be.
rem The server and the certificate installer copy it across, so use the new file once
rem it is there, and the new folder when no file is set or the set file is missing.
set "EVEJS_CERT_DIR=%EVEJS_REPO_ROOT%\_local\certs"
if defined EVEJS_DATA_ROOT for %%I in ("%EVEJS_DATA_ROOT%") do set "EVEJS_CERT_DIR=%%~fI\certs"
if /I "%EVEJS_CA_PEM%"=="%EVEJS_REPO_ROOT%\server\certs\xmpp-ca-cert.pem" if exist "%EVEJS_CERT_DIR%\xmpp-ca-cert.pem" set "EVEJS_CA_PEM="
if defined EVEJS_CA_PEM if not exist "%EVEJS_CA_PEM%" set "EVEJS_CA_PEM="
if not defined EVEJS_CA_PEM set "EVEJS_CA_PEM=%EVEJS_CERT_DIR%\xmpp-ca-cert.pem"
set "EVEJS_CERT_DIR="


rem Check whether setup already completed.
set "NEEDS_SETUP=0"

if not defined EVEJS_CLIENT_PATH (
  set "NEEDS_SETUP=1"
) else if not exist "%EVEJS_CLIENT_PATH%" (
  set "NEEDS_SETUP=1"
)

if not exist "%EVEJS_CA_PEM%" (
  set "NEEDS_SETUP=1"
)

set "CLIENT_EXE="
if defined EVEJS_CLIENT_EXE if exist "%EVEJS_CLIENT_EXE%" set "CLIENT_EXE=%EVEJS_CLIENT_EXE%"
if not defined CLIENT_EXE if defined EVEJS_CLIENT_PATH if exist "%EVEJS_CLIENT_PATH%\bin64\exefile.exe" set "CLIENT_EXE=%EVEJS_CLIENT_PATH%\bin64\exefile.exe"
if not defined CLIENT_EXE if defined EVEJS_CLIENT_PATH if exist "%EVEJS_CLIENT_PATH%\bin\exefile.exe" set "CLIENT_EXE=%EVEJS_CLIENT_PATH%\bin\exefile.exe"
if not defined CLIENT_EXE set "NEEDS_SETUP=1"

if "%NEEDS_SETUP%"=="1" (
  echo   [ERROR] First-time setup required.
  if exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\StartClientSetup.bat" (
    echo       Run tools\ClientSETUP\StartClientSetup.bat first.
  ) else (
    echo       Run the Client Setup launcher that came with this copy first.
  )
  pause
  exit /b 1
)

if not exist "%CLIENT_EXE%" (
  echo   [ERROR] Client executable not found: %CLIENT_EXE%
  echo       Run the setup wizard again or edit %EVEJS_CONFIG_DIR%\EvEJSConfig.bat
  pause
  exit /b 1
)

if not exist "%EVEJS_CA_PEM%" (
  echo   [ERROR] Certificate file missing: %EVEJS_CA_PEM%
  echo       Run the setup wizard again to install certificates.
  pause
  exit /b 1
)

for %%I in ("%CLIENT_EXE%") do set "CLIENT_DIR=%%~dpI"
for %%I in ("%CLIENT_DIR%..") do set "CLIENT_ROOT=%%~fI"

rem The two Windows Firewall blocks for the client are recommended, not required.
rem The default is warn: when the blocks are not active the helper exits 2, and
rem Play warns and starts anyway. EVEJS_FIREWALL_GATE=enforce in EvEJSConfig.bat
rem makes Play refuse to start instead.
rem The client identity checks in the same helper still exit 1 and stop Play.
rem Keep exit /b last in the block below: cmd /c returns 0 for an exit /b that
rem has more commands after it in an enclosing block.
if not defined EVEJS_FIREWALL_GATE set "EVEJS_FIREWALL_GATE=warn"
set "EVEJS_FIREWALL_STATUS=both program blocks and active firewall verified"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Set-EvEJSFirewall.ps1" -Mode Check -ClientPath "%EVEJS_CLIENT_PATH%" -ClientExe "%CLIENT_EXE%" -FirewallGate "%EVEJS_FIREWALL_GATE%"
if not "!errorlevel!"=="0" (
  set "EVEJS_FIREWALL_EXIT=!errorlevel!"
  set "EVEJS_FIREWALL_STATUS="
  if "!EVEJS_FIREWALL_EXIT!"=="2" if /I "%EVEJS_FIREWALL_GATE%"=="warn" set "EVEJS_FIREWALL_STATUS=NOT verified, recommended blocks not active"
  if not defined EVEJS_FIREWALL_STATUS (
    pause
    exit /b 1
  )
)

call :EnsureClientNetworkPatches
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

call :ValidateClientSetup
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

call :ResolveClientResourceCache
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

call :ValidateClientResourceCache
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

call :EnsureClientDisplaySafety
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

call :EnsureClientCertificateTrust
if not "!errorlevel!"=="0" (
  echo   [Certificate gate] Run SetupEveJS.bat -Only certs,client-offline before Play.
  pause
  exit /b 1
)

call :ApplyClientNetworkPolicy "%EVEJS_PROXY_URL%"
if not "!errorlevel!"=="0" (
  echo   [ERROR] Could not apply client network policy.
  pause
  exit /b 1
)

call :EnsureServerAvailable
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Test-EvEJSOfflineServer.ps1" -ProxyUrl "%EVEJS_PROXY_URL%" -RepoRoot "%EVEJS_REPO_ROOT%"
if not "!errorlevel!"=="0" (
  pause
  exit /b 1
)

call :WriteLaunchDiagnostics

echo   Launching EVE client...
echo.
echo     Client: %CLIENT_EXE% %EVEJS_CLIENT_CONSOLE_ARG%/port:%EVEJS_GAME_SERVER_PORT%
echo     ResFiles: %EO_REMOTEFILECACHEFOLDER%
echo     Proxy:  %EVEJS_PROXY_URL%
echo     CA cert: %EVEJS_CA_PEM%
echo     Network patches: exact LaunchDarkly and crash-upload hashes verified
echo     Firewall: %EVEJS_FIREWALL_STATUS%
echo     Certificates: constrained CA and client trust verified
echo     Diagnostics: %EVEJS_LAUNCH_DIAG%
echo.
echo   ============================================================
echo     Game is running. This window will stay open when you exit.
echo   ============================================================
echo.

if "%EVEJS_DRY_RUN%"=="1" (
  echo   Dry run complete. Client launch skipped.
  ping -n 3 127.0.0.1 >nul 2>&1
  exit /b 0
)

call :PrepareClientCrashDiagnostics

cd /d "%CLIENT_DIR%"
if "%EVEJS_CLIENT_DEBUG%"=="1" goto :LaunchClientWithConsole
set "EVEJS_CLIENT_STDIO_LOG=%EVEJS_DIAGNOSTICS_DIR%\evejs-client-stdout-%RANDOM%%RANDOM%.log"
echo   Client stdio log: %EVEJS_CLIENT_STDIO_LOG%
echo   Client crash report: %EVEJS_CLIENT_CRASH_REPORT%
echo.
rem Give legacy raw stdout/stderr writes a stable file-backed sink so client-side prints do not hit EBADF/cp0.
"%CLIENT_EXE%" /noCrashReportUpload /resfileserver=%EVEJS_RESOURCE_SERVER% /port:%EVEJS_GAME_SERVER_PORT% 1>>"%EVEJS_CLIENT_STDIO_LOG%" 2>&1
set "EVEJS_EXIT=%errorlevel%"
goto :ClientExited

:LaunchClientWithConsole
rem The debug console is the client's own window, so its output is not redirected.
set "EVEJS_CLIENT_STDIO_LOG="
echo   Client crash report: %EVEJS_CLIENT_CRASH_REPORT%
echo.
"%CLIENT_EXE%" /console /noCrashReportUpload /resfileserver=%EVEJS_RESOURCE_SERVER% /port:%EVEJS_GAME_SERVER_PORT%
set "EVEJS_EXIT=%errorlevel%"

:ClientExited
call :WriteClientCrashReport
set "EVEJS_CRASH_EVENTS=%errorlevel%"

echo.
if "%EVEJS_EXIT%"=="0" (
  echo   Client exited cleanly. See you next time!
) else (
  echo   Client exited with code %EVEJS_EXIT%.
  if defined EVEJS_CLIENT_STDIO_LOG (
    echo   Client stdio log: %EVEJS_CLIENT_STDIO_LOG%
    call :PrintClientStdioTail
  )
)
echo   Launch diagnostics: %EVEJS_LAUNCH_DIAG%
echo   Client crash report: %EVEJS_CLIENT_CRASH_REPORT%
if "%EVEJS_CRASH_EVENTS%"=="2" (
  echo.
  echo   Windows recorded a matching client crash event.
  echo   Send the crash report above if this is still failing.
)

echo.
echo   Press any key to close this launcher.
pause >nul
exit /b %EVEJS_EXIT%

:ValidateClientSetup
set "EVEJS_START_INI=%EVEJS_CLIENT_PATH%\start.ini"
if not exist "%EVEJS_START_INI%" (
  echo.
  echo   [ERROR] start.ini was not found in the configured client:
  echo       %EVEJS_START_INI%
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 5.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ini=$env:EVEJS_START_INI; $server=$null; $crypto=$null; foreach($line in Get-Content -LiteralPath $ini){ if($line -match '^\s*(server|serverip)\s*=\s*(.+?)\s*$'){ $server=$Matches[2].Trim() }; if($line -match '^\s*cryptoPack\s*=\s*(.+?)\s*$'){ $crypto=$Matches[1].Trim() } }; if($server -ne '127.0.0.1'){ exit 3 }; if($crypto -ne 'Placebo'){ exit 4 }; exit 0"
set "EVEJS_START_INI_EXIT=%errorlevel%"
if "%EVEJS_START_INI_EXIT%"=="3" (
  echo.
  echo   [ERROR] start.ini is not pointed at the local EvEJS server.
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 5.
  exit /b 1
)
if "%EVEJS_START_INI_EXIT%"=="4" (
  echo.
  echo   [ERROR] start.ini is not using cryptoPack = Placebo.
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 5.
  exit /b 1
)
if not "%EVEJS_START_INI_EXIT%"=="0" (
  echo.
  echo   [ERROR] Could not validate start.ini.
  echo       Run tools\ClientSETUP\StartClientSetup.bat again.
  exit /b 1
)

set "EVEJS_BLUE_DLL=%EVEJS_CLIENT_PATH%\bin64\blue.dll"
if not exist "%EVEJS_BLUE_DLL%" (
  echo.
  echo   [ERROR] blue.dll was not found in the configured client:
  echo       %EVEJS_BLUE_DLL%
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 4.
  exit /b 1
)

:ValidateBlueDllStatus
set "EVEJS_BLUE_STATUS=%TEMP%\evejs-blue-status-%RANDOM%%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\blue_dll_patch.ps1" --status --input "%EVEJS_BLUE_DLL%" >"%EVEJS_BLUE_STATUS%" 2>&1
set "EVEJS_BLUE_EXIT=%errorlevel%"
set "EVEJS_BLUE_STATE="
set "EVEJS_BLUE_MESSAGE="
for /f "usebackq tokens=1,* delims==" %%A in ("%EVEJS_BLUE_STATUS%") do (
  if /I "%%A"=="state" set "EVEJS_BLUE_STATE=%%B"
  if /I "%%A"=="message" set "EVEJS_BLUE_MESSAGE=%%B"
)
del "%EVEJS_BLUE_STATUS%" >nul 2>&1

if not defined EVEJS_BLUE_STATE call :FallbackBlueDllStatus

if not "%EVEJS_BLUE_EXIT%"=="0" (
  echo.
  echo   [ERROR] Could not inspect blue.dll.
  echo       Run tools\ClientSETUP\StartClientSetup.bat and complete Step 4.
  exit /b 1
)
if /I "%EVEJS_BLUE_STATE%"=="already_patched" exit /b 0

if /I "%EVEJS_BLUE_STATE%"=="patchable_original" (
  echo   blue.dll is the supported original build. Patching it automatically...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\blue_dll_patch.ps1" --input "%EVEJS_BLUE_DLL%" --in-place >"%TEMP%\evejs-blue-auto-patch.log" 2>&1
  if not "!errorlevel!"=="0" (
    echo.
    echo   [ERROR] Automatic blue.dll patch failed.
    echo       Patch log: %TEMP%\evejs-blue-auto-patch.log
    echo       Configured client: %EVEJS_CLIENT_PATH%
    echo       blue.dll checked:  %EVEJS_BLUE_DLL%
    exit /b 1
  )
  goto ValidateBlueDllStatus
)

if /I not "%EVEJS_BLUE_STATE%"=="already_patched" (
  echo.
  echo   [ERROR] blue.dll is not patched for EvEJS.
  if defined EVEJS_BLUE_MESSAGE echo       %EVEJS_BLUE_MESSAGE%
  echo.
  echo       Config file loaded:
  echo         %EVEJS_CONFIG_DIR%\EvEJSConfig.bat
  echo       Configured client:
  echo         %EVEJS_CLIENT_PATH%
  echo       Client executable that %EVEJS_LAUNCHER_NAME% will launch:
  echo         %CLIENT_EXE%
  echo       blue.dll file checked:
  echo         %EVEJS_BLUE_DLL%
  echo       Detected blue.dll state:
  echo         %EVEJS_BLUE_STATE%
  echo.
  echo       If you manually copied a patched blue.dll, copy it over the exact
  echo       blue.dll path shown above. If that path is not your EveJS copy,
  echo       run tools\ClientSETUP\StartClientSetup.bat and select the right client.
  exit /b 1
)
exit /b 0

:FallbackBlueDllStatus
set "EVEJS_BLUE_SIZE="
set "EVEJS_BLUE_HASH="
for /f "usebackq tokens=1,2 delims=," %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=$env:EVEJS_BLUE_DLL; if(-not (Test-Path -LiteralPath $p -PathType Leaf)){exit 1}; $i=Get-Item -LiteralPath $p; $h=(Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant(); Write-Output ($i.Length.ToString() + ',' + $h)"`) do (
  set "EVEJS_BLUE_SIZE=%%A"
  set "EVEJS_BLUE_HASH=%%B"
)
if "%EVEJS_BLUE_SIZE%"=="12068352" if /I "%EVEJS_BLUE_HASH%"=="7f8e19adfe002ab91d5c2ac0b317bbcfed4514000d6be0f5eb619d614f22d93f" (
  set "EVEJS_BLUE_STATE=already_patched"
  set "EVEJS_BLUE_MESSAGE=blue.dll matches the known stripped EvEJS patched build."
  set "EVEJS_BLUE_EXIT=0"
)
set "EVEJS_BLUE_SIZE="
set "EVEJS_BLUE_HASH="
exit /b 0

:EnsureClientDisplaySafety
if /I "%EVEJS_CLIENT_SAFE_WINDOWED%"=="on" (
  echo   Preparing safe windowed display settings...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\PrepareClientSettings.ps1" -Mode Display
  set "EVEJS_DISPLAY_EXIT=!errorlevel!"
  if not "!EVEJS_DISPLAY_EXIT!"=="0" (
    echo.
    echo   [ERROR] Could not prepare safe client display settings.
    echo       This usually means Windows blocked access to %%LOCALAPPDATA%%\CCP\EVE
    echo       or the configured client path is invalid.
    exit /b !EVEJS_DISPLAY_EXIT!
  )
)
if /I "%EVEJS_CLIENT_SAFE_GRAPHICS%"=="on" (
  call :EnsureClientGraphicsSafety
  exit /b !errorlevel!
)
exit /b 0

:EnsureClientGraphicsSafety
echo   Preparing safe low graphics settings...
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\PrepareClientSettings.ps1" -Mode Graphics
exit /b %errorlevel%

:EnsureServerAvailable
echo   Checking local EvEJS server...
for /L %%N in (1,1,30) do (
  call :CheckGameServerPort
  set "EVEJS_GAME_PORT_OK=!errorlevel!"
  call :CheckProxyHealth
  set "EVEJS_PROXY_OK=!errorlevel!"
  if "!EVEJS_GAME_PORT_OK!"=="0" if "!EVEJS_PROXY_OK!"=="0" (
    echo   Local server is ready.
    exit /b 0
  )
  if "%%N"=="1" (
    echo   Waiting for StartServer.bat to finish booting the game server and proxy...
  )
  ping -n 2 127.0.0.1 >nul 2>&1
)

echo.
echo   [ERROR] EvEJS server is not reachable yet.
echo       Start the server first with StartServer.bat, then choose option 2
echo       or run %EVEJS_LAUNCHER_NAME% only after the server window says it is running.
echo.
echo       Expected:
echo         Game TCP: 127.0.0.1:%EVEJS_GAME_SERVER_PORT%
echo         Proxy:    %EVEJS_PROXY_URL%health
exit /b 1

:CheckGameServerPort
powershell -NoProfile -ExecutionPolicy Bypass -Command "$client=[Net.Sockets.TcpClient]::new(); try { $iar=$client.BeginConnect('127.0.0.1',[int]$env:EVEJS_GAME_SERVER_PORT,$null,$null); if(-not $iar.AsyncWaitHandle.WaitOne(750,$false)){ exit 1 }; $client.EndConnect($iar); exit 0 } catch { exit 1 } finally { $client.Close() }" >nul 2>&1
exit /b %errorlevel%

:CheckProxyHealth
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r=$null; try { $base=[Uri]$env:EVEJS_PROXY_URL; $health=[Uri]::new($base,'health'); $q=[Net.HttpWebRequest]::Create($health); $q.Proxy=$null; $q.AllowAutoRedirect=$false; $q.Timeout=2000; $r=$q.GetResponse(); if([int]$r.StatusCode -eq 200){ exit 0 }; exit 1 } catch { exit 1 } finally { if($r){$r.Dispose()} }" >nul 2>&1
exit /b %errorlevel%

:WriteLaunchDiagnostics
call :EnsureDiagnosticsDir
set "EVEJS_LAUNCH_DIAG=%EVEJS_DIAGNOSTICS_DIR%\evejs-launch-diagnostics-%RANDOM%%RANDOM%.txt"
(
  echo EveJS launch diagnostics
  echo Timestamp: %DATE% %TIME%
  echo RepoRoot: %EVEJS_REPO_ROOT%
  echo ConfigDir: %EVEJS_CONFIG_DIR%
  echo ClientPath: %EVEJS_CLIENT_PATH%
  echo ClientExe: %CLIENT_EXE%
  echo ClientDir: %CLIENT_DIR%
  echo ClientRoot: %CLIENT_ROOT%
  echo ResFiles: %EO_REMOTEFILECACHEFOLDER%
  echo CacheRoot: %EVEJS_CLIENT_CACHE_ROOT%
  echo ResourceIndex: %EVEJS_CLIENT_INDEX%
  echo ProxyUrl: %EVEJS_PROXY_URL%
  echo GameServerPort: %EVEJS_GAME_SERVER_PORT%
  echo CaPem: %EVEJS_CA_PEM%
  echo NetworkPatches: LaunchDarkly and crash-upload loopback hashes verified
  echo Firewall: %EVEJS_FIREWALL_STATUS%
  echo OfflineServer: forwarding disabled; client defaults; shared gateway TLS verified
  echo SafeWindowed: %EVEJS_CLIENT_SAFE_WINDOWED%
  echo SafeGraphics: %EVEJS_CLIENT_SAFE_GRAPHICS%
  echo WindowWidth: %EVEJS_CLIENT_WINDOW_WIDTH%
  echo WindowHeight: %EVEJS_CLIENT_WINDOW_HEIGHT%
  echo BlueState: %EVEJS_BLUE_STATE%
  echo BlueMessage: %EVEJS_BLUE_MESSAGE%
  echo StartIni: %EVEJS_START_INI%
  echo.
  echo --- start.ini ---
  type "%EVEJS_START_INI%"
  echo.
  echo --- Connectivity ---
  echo Game TCP 127.0.0.1:%EVEJS_GAME_SERVER_PORT% checked before launch.
  echo Proxy health %EVEJS_PROXY_URL%health checked before launch.
  echo.
  echo --- User report checklist ---
  echo Send this file, the launcher window text, and %EVEJS_SUPPORT_HINT%.
) > "%EVEJS_LAUNCH_DIAG%" 2>nul
exit /b 0

:EnsureDiagnosticsDir
if not defined EVEJS_DIAGNOSTICS_DIR set "EVEJS_DIAGNOSTICS_DIR=%EVEJS_REPO_ROOT%\_local\diagnostics"
if not exist "%EVEJS_DIAGNOSTICS_DIR%\" mkdir "%EVEJS_DIAGNOSTICS_DIR%" >nul 2>&1
if not exist "%EVEJS_DIAGNOSTICS_DIR%\" set "EVEJS_DIAGNOSTICS_DIR=%TEMP%"
exit /b 0

:PrepareClientCrashDiagnostics
call :EnsureDiagnosticsDir
set "EVEJS_CLIENT_CRASH_REPORT=%EVEJS_DIAGNOSTICS_DIR%\evejs-client-crash-%RANDOM%%RANDOM%.txt"
set "EVEJS_CLIENT_LAUNCH_UTC="
for /f "delims=" %%T in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-Date -Format o"') do set "EVEJS_CLIENT_LAUNCH_UTC=%%T"
if not defined EVEJS_CLIENT_LAUNCH_UTC set "EVEJS_CLIENT_LAUNCH_UTC=%DATE% %TIME%"
call :WritePrelaunchCrashReport
exit /b 0

:WritePrelaunchCrashReport
(
  echo EveJS client crash report
  echo Timestamp: %DATE% %TIME%
  echo Status: Created before exefile.exe launched. If this file still says pre-launch, the launcher was closed or killed before the client returned control.
  echo Launch UTC: %EVEJS_CLIENT_LAUNCH_UTC%
  echo Client exe: %CLIENT_EXE%
  echo Client path: %EVEJS_CLIENT_PATH%
  echo blue.dll: %EVEJS_BLUE_DLL%
  echo Blue state: %EVEJS_BLUE_STATE%
  echo Blue message: %EVEJS_BLUE_MESSAGE%
  echo ResFiles: %EO_REMOTEFILECACHEFOLDER%
  echo CacheRoot: %EVEJS_CLIENT_CACHE_ROOT%
  echo ResourceIndex: %EVEJS_CLIENT_INDEX%
  echo Proxy: %EVEJS_PROXY_URL%
  echo Launch diagnostics: %EVEJS_LAUNCH_DIAG%
) > "%EVEJS_CLIENT_CRASH_REPORT%" 2>nul
exit /b 0

:WriteClientCrashReport
if not defined EVEJS_CLIENT_CRASH_REPORT (
  call :PrepareClientCrashDiagnostics
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$report=$env:EVEJS_CLIENT_CRASH_REPORT; try { $start=[DateTime]::Parse($env:EVEJS_CLIENT_LAUNCH_UTC).AddSeconds(-5) } catch { $start=(Get-Date).AddMinutes(-5) }; $exe=[IO.Path]::GetFileName($env:CLIENT_EXE); $lines=New-Object System.Collections.Generic.List[string]; $lines.Add('EveJS client crash report'); $lines.Add('Timestamp: ' + (Get-Date -Format o)); $lines.Add('Launch UTC: ' + $env:EVEJS_CLIENT_LAUNCH_UTC); $lines.Add('Exit code: ' + $env:EVEJS_EXIT); $lines.Add('Client exe: ' + $env:CLIENT_EXE); $lines.Add('Client path: ' + $env:EVEJS_CLIENT_PATH); $lines.Add('blue.dll: ' + $env:EVEJS_BLUE_DLL); $lines.Add('Blue state: ' + $env:EVEJS_BLUE_STATE); $lines.Add('ResFiles: ' + $env:EO_REMOTEFILECACHEFOLDER); $lines.Add('Proxy: ' + $env:EVEJS_PROXY_URL); $lines.Add(''); $lines.Add('Recent Windows Application crash events:'); $found=0; try { $events=Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$start} -ErrorAction Stop | Where-Object { $m=[string]$_.Message; $m -match [regex]::Escape($exe) -or $m -match 'blue\.dll|exefile\.exe|trinity|python|ucrtbase|KERNELBASE|ntdll|d3d|DirectX' } | Select-Object -First 10; foreach($event in $events){ $found++; $lines.Add('---'); $lines.Add('Time: ' + $event.TimeCreated); $lines.Add('Provider: ' + $event.ProviderName); $lines.Add('EventId: ' + $event.Id); $lines.Add('Level: ' + $event.LevelDisplayName); $lines.Add(($event.Message -replace '\r?\n', ' ')) } } catch { $lines.Add('Unable to read Windows Application event log: ' + $_.Exception.Message) }; if($found -eq 0){ $lines.Add('No matching crash events were found since launch.') }; Set-Content -LiteralPath $report -Value $lines -Encoding UTF8; if($found -gt 0){ exit 2 }; exit 0"
set "EVEJS_CRASH_REPORT_EXIT=%errorlevel%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$report=$env:EVEJS_CLIENT_CRASH_REPORT; try { $start=[DateTime]::Parse($env:EVEJS_CLIENT_LAUNCH_UTC).AddSeconds(-30) } catch { $start=(Get-Date).AddMinutes(-10) }; $lines=New-Object System.Collections.Generic.List[string]; $lines.Add(''); $lines.Add('Recent Windows System stability events:'); $found=0; $pattern='Display|nvlddmkm|amdwddmg|igfx|LiveKernelEvent|WHEA|BugCheck|Kernel-Power|Display driver|TDR|DirectX|D3D|hardware error'; try { $events=Get-WinEvent -FilterHashtable @{LogName='System'; StartTime=$start; Level=1,2,3} -ErrorAction Stop | Where-Object { $_.ProviderName -match 'Display|nvlddmkm|amdwddmg|igfx|WHEA-Logger|BugCheck|Kernel-Power|Microsoft-Windows-WER-SystemErrorReporting' -or ([string]$_.Message) -match $pattern } | Select-Object -First 15; foreach($event in $events){ $found++; $lines.Add('---'); $lines.Add('Time: ' + $event.TimeCreated); $lines.Add('Provider: ' + $event.ProviderName); $lines.Add('EventId: ' + $event.Id); $lines.Add('Level: ' + $event.LevelDisplayName); $lines.Add(($event.Message -replace '\r?\n', ' ')) } } catch { $lines.Add('Unable to read Windows System event log: ' + $_.Exception.Message) }; if($found -eq 0){ $lines.Add('No matching System stability events were found since launch.') }; Add-Content -LiteralPath $report -Value $lines -Encoding UTF8; if($found -gt 0){ exit 2 }; exit 0"
if not "%errorlevel%"=="0" set "EVEJS_CRASH_REPORT_EXIT=%errorlevel%"
exit /b %EVEJS_CRASH_REPORT_EXIT%

:PrintClientStdioTail
if not exist "%EVEJS_CLIENT_STDIO_LOG%" exit /b 0
echo.
echo   Last client stdio lines:
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Get-Content -LiteralPath $env:EVEJS_CLIENT_STDIO_LOG -Tail 25 } catch { Write-Host ('Unable to read client stdio log: ' + $_.Exception.Message) }"
exit /b 0

:ApplyClientNetworkPolicy
if "%~1"=="" exit /b 1

set "EVEJS_PROXY_TARGET=%~1"
set "EVEJS_PROXY_LOCAL_INTERCEPT=1"

set "http_proxy=%EVEJS_PROXY_TARGET%"
set "https_proxy=%EVEJS_PROXY_TARGET%"
set "HTTP_PROXY=%EVEJS_PROXY_TARGET%"
set "HTTPS_PROXY=%EVEJS_PROXY_TARGET%"
set "all_proxy=%EVEJS_PROXY_TARGET%"
set "ALL_PROXY=%EVEJS_PROXY_TARGET%"

set "EVEJS_NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=%EVEJS_NO_PROXY%"
set "NO_PROXY=%EVEJS_NO_PROXY%"

rem Keep the DSN valid and local; an empty cmd variable restores the retail default.
set "EVEJS_PROXY_PORT="
for /f "delims=" %%P in ('powershell -NoProfile -Command "$u=[Uri]$env:EVEJS_PROXY_TARGET; if($u.Scheme -ne 'http' -or $u.Host -ne '127.0.0.1' -or $u.UserInfo -or $u.Query -or $u.Fragment -or $u.AbsolutePath -ne '/'){exit 1}; Write-Output $u.Port"') do set "EVEJS_PROXY_PORT=%%P"
if not defined EVEJS_PROXY_PORT (
  echo   [Proxy endpoint gate] Set the local proxy URL to http://127.0.0.1:26002/ in config/server.json.
  exit /b 1
)
set "EVE_CLIENT_SENTRY_DSN=http://evejs@127.0.0.1:%EVEJS_PROXY_PORT%/1"
set "EVEJS_RESOURCE_SERVER=http://127.0.0.1:%EVEJS_PROXY_PORT%/resfiles/"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Prepare-EvEJSOfflinePreferences.ps1" -ClientPath "%EVEJS_CLIENT_PATH%" -ClientExe "%CLIENT_EXE%" -SentryDsn "%EVE_CLIENT_SENTRY_DSN%"
if not "!errorlevel!"=="0" exit /b 1

set "EVEJS_PROXY_TARGET="
exit /b 0

:EnsureClientNetworkPatches
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Set-EvEJSClientNetworkPatches.ps1" -ClientPath "%EVEJS_CLIENT_PATH%" -ClientExe "%CLIENT_EXE%" -Mode Apply
exit /b %errorlevel%

:ResolveClientResourceCache
set "EVEJS_CLIENT_RESFILES="
set "EVEJS_CLIENT_CACHE_ROOT="

rem ClientSETUP stores EVEJS_CLIENT_PATH as the selected client's tq folder.
rem The EVE resource cache for that same client lives beside tq as ..\ResFiles.
if defined EVEJS_CLIENT_PATH (
  for %%I in ("%EVEJS_CLIENT_PATH%\..") do set "EVEJS_CLIENT_CACHE_ROOT=%%~fI"
)

rem If an explicit executable was configured, derive the same cache from that executable.
if not defined EVEJS_CLIENT_CACHE_ROOT if defined CLIENT_ROOT (
  for %%I in ("%CLIENT_ROOT%\..") do set "EVEJS_CLIENT_CACHE_ROOT=%%~fI"
)

if defined EVEJS_CLIENT_CACHE_ROOT set "EVEJS_CLIENT_RESFILES=%EVEJS_CLIENT_CACHE_ROOT%\ResFiles"
if defined EVEJS_CLIENT_CACHE_ROOT set "EVEJS_CLIENT_INDEX=%EVEJS_CLIENT_CACHE_ROOT%\index_tranquility.txt"

if not defined EVEJS_CLIENT_RESFILES (
  echo.
  echo   [ERROR] Could not resolve the configured client's ResFiles folder.
  echo       Run tools\ClientSETUP\StartClientSetup.bat again.
  exit /b 1
)

if not exist "%EVEJS_CLIENT_RESFILES%\" (
  echo.
  echo   [ERROR] Client ResFiles folder is missing:
  echo       %EVEJS_CLIENT_RESFILES%
  echo.
  echo       This usually means only the tq folder was copied.
  echo       Copy the full EVE client/shared-cache folder, including:
  echo         %EVEJS_CLIENT_CACHE_ROOT%\ResFiles
  echo         %EVEJS_CLIENT_CACHE_ROOT%\index_tranquility.txt
  exit /b 1
)

set "EO_REMOTEFILECACHEFOLDER=%EVEJS_CLIENT_RESFILES%"
exit /b 0

:ValidateClientResourceCache
echo   Checking client resource folder and indexes...
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Test-EvEJSResources.ps1" -ClientPath "%EVEJS_CLIENT_PATH%" -ResFilesPath "%EO_REMOTEFILECACHEFOLDER%"
exit /b %errorlevel%

:EnsureClientCertificateTrust
set "EVEJS_CERT_INSTALLER=%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1"
if not exist "%EVEJS_CERT_INSTALLER%" (
  echo.
  echo   [ERROR] Certificate installer is missing:
  echo       %EVEJS_CERT_INSTALLER%
  set "EVEJS_CERT_INSTALLER="
  exit /b 1
)

echo   Checking client certificate trust...
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_CERT_INSTALLER%" -CheckOnly -ClientPath "%EVEJS_CLIENT_PATH%"
set "EVEJS_CERT_EXIT=%errorlevel%"
set "EVEJS_CERT_INSTALLER="
if not "%EVEJS_CERT_EXIT%"=="0" exit /b %EVEJS_CERT_EXIT%
exit /b 0

:ResolveServerEndpoints
set "EVEJS_GAME_SERVER_PORT=26000"
if not defined EVEJS_PROXY_URL set "EVEJS_PROXY_URL=http://127.0.0.1:26002/"
set "EVEJS_ENDPOINT_HELPER=%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\Resolve-EvEJSEndpoints.ps1"
if not exist "%EVEJS_ENDPOINT_HELPER%" (
  echo   [Endpoint gate] Restore tools\ClientSETUP\scripts\Resolve-EvEJSEndpoints.ps1 from this release.
  exit /b 1
)
set "EVEJS_ENDPOINT_RESULT=%TEMP%\evejs-endpoints-%RANDOM%%RANDOM%.txt"
powershell -NoProfile -ExecutionPolicy Bypass -File "%EVEJS_ENDPOINT_HELPER%" -RepoRoot "%EVEJS_REPO_ROOT%" -Format Batch >"%EVEJS_ENDPOINT_RESULT%" 2>&1
set "EVEJS_ENDPOINT_EXIT=%errorlevel%"
if not "%EVEJS_ENDPOINT_EXIT%"=="0" (
  echo.
  echo   [ERROR] Could not resolve server endpoints from config\server.json.
  type "%EVEJS_ENDPOINT_RESULT%"
  del "%EVEJS_ENDPOINT_RESULT%" >nul 2>&1
  exit /b %EVEJS_ENDPOINT_EXIT%
)
for /f "usebackq tokens=1,* delims==" %%A in ("%EVEJS_ENDPOINT_RESULT%") do (
  if /I "%%A"=="EVEJS_GAME_SERVER_PORT" set "EVEJS_GAME_SERVER_PORT=%%B"
  if /I "%%A"=="EVEJS_PROXY_URL" set "EVEJS_PROXY_URL=%%B"
)
del "%EVEJS_ENDPOINT_RESULT%" >nul 2>&1
set "EVEJS_ENDPOINT_RESULT="
set "EVEJS_ENDPOINT_HELPER="
set "EVEJS_ENDPOINT_EXIT="
exit /b 0

:ResolveConfigDir
set "EVEJS_CONFIG_DIR="
if not exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat" if exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.example.bat" (
  copy /y "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.example.bat" "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat" >nul
)
if exist "%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts"
  exit /b 0
)
if exist "%EVEJS_REPO_ROOT%\scripts\windows\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%EVEJS_REPO_ROOT%\scripts\windows"
  exit /b 0
)
if exist "%~dp0scripts\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%~dp0scripts"
  exit /b 0
)
if exist "%~dp0scripts\windows\EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%~dp0scripts\windows"
  exit /b 0
)
if exist "%~dp0EvEJSConfig.bat" (
  set "EVEJS_CONFIG_DIR=%~dp0"
  exit /b 0
)
echo.
echo   [ERROR] Launcher config was not found.
echo       Looked for EvEJSConfig.bat under:
echo       %EVEJS_REPO_ROOT%\tools\ClientSETUP\scripts
echo       %EVEJS_REPO_ROOT%\scripts\windows
echo       %~dp0scripts
echo.
echo       Update your launcher files or run the Client Setup wizard again.
pause
exit /b 1
