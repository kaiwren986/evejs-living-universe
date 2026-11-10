@echo off
rem EveJS RPG fork: download the NPC model named in config\llm.json through LM Studio.
rem One-time step; PlayRPG.bat loads it automatically afterwards.
setlocal
set "ROOT=%~dp0..\.."
for /f "usebackq delims=" %%M in (`powershell -NoProfile -Command "(Get-Content '%ROOT%\config\llm.json' -Raw | ConvertFrom-Json).model"`) do set "MODEL=%%M"
if not defined MODEL (
  echo   No model set. Put an LM Studio model key in config\llm.json "model" first.
  pause
  exit /b 1
)
echo   Downloading %MODEL% with LM Studio...
"%USERPROFILE%\.lmstudio\bin\lms.exe" get "%MODEL%" -y
pause
