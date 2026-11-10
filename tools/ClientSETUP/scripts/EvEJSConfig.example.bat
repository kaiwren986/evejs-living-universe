@echo off
for %%I in ("%~dp0..\..\..") do set "EVEJS_REPO_ROOT=%%~fI"

rem Edit this path if your EVE client copy lives somewhere else.
set "EVEJS_CLIENT_PATH=%EVEJS_REPO_ROOT%\client\EVE\tq"

rem Leave this blank unless you want to point directly at exefile.exe.
set "EVEJS_CLIENT_EXE="

rem Play.bat resolves game and gateway endpoints from config\server.json.

rem The local CA the client trusts. The certificate installer keeps it in the data
rem root's certs folder: EVEJS_DATA_ROOT\certs if that is set, else _local\certs.
set "EVEJS_CA_PEM=%EVEJS_REPO_ROOT%\_local\certs\xmpp-ca-cert.pem"

rem Graphics safety is opt-in because it overwrites GPU quality settings.
set "EVEJS_CLIENT_SAFE_GRAPHICS=off"

rem Display/window safety is opt-in because it still writes the client settings file.
set "EVEJS_CLIENT_SAFE_WINDOWED=off"

rem The two Windows Firewall blocks for the EveJS client are recommended, not
rem required. Play warns when they are missing and starts anyway. To add them,
rem run SetupEveJS.bat -Only firewall. To make Play refuse to start without
rem them, remove "rem " from the next line. See doc\OFFLINE.md.
rem set "EVEJS_FIREWALL_GATE=enforce"
