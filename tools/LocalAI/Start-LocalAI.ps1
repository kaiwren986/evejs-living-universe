# EveJS RPG fork: start the local AI that voices NPCs, with no clicks.
#
# Reads config/llm.json, starts LM Studio's headless server on localhost and loads
# the configured model under a fixed identifier. Safe to run any number of times:
# a running server or an already loaded model is left alone. When no model is set
# or LM Studio is missing it says so and exits 0; the game falls back to written
# lines, so nothing here can stop you playing.
#
#   powershell -File tools\LocalAI\Start-LocalAI.ps1 [-Wait]
param([switch]$Wait)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$configPath = Join-Path $root 'config\llm.json'

function Say($text) { Write-Host "  [Local AI] $text" }

if (-not (Test-Path $configPath)) { Say 'config\llm.json not found; skipping.'; exit 0 }
$config = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not $config.enabled) { Say 'disabled in config\llm.json.'; exit 0 }
if (-not $config.autoStart) { Say 'autoStart is off; expecting you to run the model yourself.'; exit 0 }
if ([string]::IsNullOrWhiteSpace($config.model)) {
  Say 'no model chosen yet (config\llm.json "model"). NPCs use written lines for now.'
  exit 0
}

$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (-not (Test-Path $lms)) {
  Say "LM Studio's command line tool was not found at $lms. Install LM Studio and open it once."
  exit 0
}

$status = (& $lms server status 2>&1 | Out-String)
if ($status -notmatch 'running on port|is running') {
  Say "starting LM Studio server on 127.0.0.1:$($config.port)..."
  & $lms server start --port $config.port 2>&1 | Out-Null
}

$loaded = (& $lms ps 2>&1 | Out-String)
if ($loaded -match [regex]::Escape($config.identifier)) {
  Say "model already loaded as '$($config.identifier)'."
  exit 0
}

Say "loading $($config.model) as '$($config.identifier)' (this can take a minute)..."
$loadArgs = @('load', $config.model, '--identifier', $config.identifier, '--gpu', "$($config.gpu)", '-y')
if ($config.contextLength) { $loadArgs += @('--context-length', "$($config.contextLength)") }
& $lms @loadArgs 2>&1 | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) {
  Say "could not load the model (exit $LASTEXITCODE). Is it downloaded? Run tools\LocalAI\GetModel.bat."
  if ($Wait) { Read-Host '  Press Enter to close' | Out-Null }
  exit 0
}
Say 'ready.'
