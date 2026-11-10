# EvEJS ErrorReport orchestrator.
#
# Figures out HOW this install runs (native Windows vs Docker), gathers the
# logs accordingly, and drives tools/ErrorReport/collect-error-report.js to
# produce one uploadable zip in the repo root.
#
#   Native : the server logs folder (_local\logs, or server\logs before the
#            server first started with logs there) exists -> run the collector directly.
#   Docker : logs live in the server container at /var/lib/evejs/logs (the
#            evejs-logs volume), so `docker compose cp` copies them out -- this works even
#            when the container has CRASHED or is stopped, which is exactly the
#            state most error reports are filed from. The collector then runs
#            inside a throwaway evejs-local container, so the host needs no
#            Node at all. The collector script itself comes from the host bind
#            mount, so images built before this tool existed work too.
#
# Windows PowerShell 5.1 compatible. Launched by ErrorReport.bat.
#
# Usage: powershell -File tools\ErrorReport\error-report.ps1 [options]
#   -Docker            force the Docker path
#   -Native            force the native path
#   -Hours <n>         log window in hours before last activity (default 6)
#   -Note <text>       description of the problem (else prompted)
#   -OutDir <dir>      where to write the zip (default: repo root)
#   -NoReveal          do not open Explorer on the finished zip

[CmdletBinding()]
param(
    [switch]$Docker,
    [switch]$Native,
    [int]$Hours = 6,
    [string]$Note = "",
    [string]$OutDir = "",
    [switch]$NoReveal
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$collector = Join-Path $repoRoot "tools\ErrorReport\collect-error-report.js"

# Run a native executable without letting stderr chatter or a missing
# container abort the script; the caller checks $script:NativeExitCode.
function Invoke-Native {
    param([string]$Executable, [string[]]$Arguments)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $output = & $Executable @Arguments 2>&1
    $script:NativeExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previous
    return $output
}

Write-Host ""
Write-Host "  ============================================================"
Write-Host "    EvEJS - Error Report"
Write-Host "  ============================================================"
Write-Host ""

# ---------------------------------------------------------------- zip naming
$version = "unknown"
$versionFile = Join-Path $repoRoot "config\version.json"
if (Test-Path $versionFile) {
    try {
        $parsed = Get-Content $versionFile -Raw | ConvertFrom-Json
        if ($parsed.evejsVersion) { $version = $parsed.evejsVersion }
    } catch { }
}
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
if (-not $OutDir) { $OutDir = $repoRoot }
$zipPath = Join-Path $OutDir ("EveJS-ErrorReport_v{0}_{1}.zip" -f $version, $stamp)

# ------------------------------------------------------------ mode detection
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$dockerCommand = Get-Command docker -ErrorAction SilentlyContinue
$hasNativeLogs = $false
$dataRootLogs = if ($env:EVEJS_DATA_ROOT) { Join-Path $env:EVEJS_DATA_ROOT "logs" } else { Join-Path $repoRoot "_local\logs" }
foreach ($logsDir in @($dataRootLogs, (Join-Path $repoRoot "server\logs"))) {
    if (Test-Path $logsDir) {
        $hasNativeLogs = $hasNativeLogs -or (@(Get-ChildItem -Path $logsDir -Filter *.log -File -ErrorAction SilentlyContinue).Count -gt 0)
    }
}

$mode = $null
if ($Docker) { $mode = "docker" }
elseif ($Native) { $mode = "native" }
elseif ($nodeCommand -and $hasNativeLogs) { $mode = "native" }
elseif ($dockerCommand -and (Test-Path (Join-Path $repoRoot "compose.yaml"))) { $mode = "docker" }
elseif ($nodeCommand) { $mode = "native" }
else {
    Write-Host "  Could not find a way to collect the report:" -ForegroundColor Red
    Write-Host "    - no server logs (_local\logs) with Node.js installed (native install), and"
    Write-Host "    - no docker command available (Docker install)."
    Write-Host "  Install Node.js LTS, or start Docker Desktop, then run this again."
    exit 1
}
Write-Host ("  Install type detected : {0}" -f $mode)

# -------------------------------------------------------------- description
if (-not $Note -and $Host.Name -eq "ConsoleHost") {
    $Note = Read-Host "  Describe what happened (optional, Enter to skip)"
}

# --------------------------------------------------------------------- run
if ($mode -eq "native") {
    if (-not $nodeCommand) {
        Write-Host "  Node.js was not found. Install Node.js LTS or use -Docker." -ForegroundColor Red
        exit 1
    }
    $arguments = @($collector, "--root", $repoRoot, "--out", $zipPath, "--hours", $Hours, "--no-prompt")
    if ($Note) { $arguments += @("--note", $Note) }
    & node @arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  The collector failed (see above)." -ForegroundColor Red
        exit 1
    }
} else {
    if (-not $dockerCommand) {
        Write-Host "  The docker command was not found. Install Docker Desktop first." -ForegroundColor Red
        exit 1
    }
    Invoke-Native "docker" @("version", "--format", "{{.Server.Os}}") | Out-Null
    if ($script:NativeExitCode -ne 0) {
        Write-Host "  Docker is installed but the engine is not running." -ForegroundColor Red
        Write-Host "  Start Docker Desktop, wait for it to finish starting, then run this again."
        exit 1
    }
    Invoke-Native "docker" @("image", "inspect", "evejs-local") | Out-Null
    if ($script:NativeExitCode -ne 0) {
        Write-Host "  The evejs-local image does not exist yet." -ForegroundColor Red
        Write-Host "  If setup never completed, run:  docker compose build init"
        exit 1
    }

    $tempRoot = Join-Path $env:TEMP ("evejs-error-report-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    $tempLogs = Join-Path $tempRoot "logs"
    New-Item -ItemType Directory -Path $tempLogs -Force | Out-Null

    Push-Location $repoRoot
    try {
        # Copy the log tree out of the server container. The trailing /. copies
        # the directory CONTENTS. Works on stopped and crashed containers too.
        Write-Host "  Copying logs out of the server container..."
        Invoke-Native "docker" @("compose", "cp", "server:/var/lib/evejs/logs/.", $tempLogs) | Out-Null
        if ($script:NativeExitCode -ne 0) {
            Write-Warning "No server container found (was it ever started, or was it removed with 'docker compose down'?). Continuing without server log files."
        }

        # Container stdout catches failures that happen BEFORE file logging
        # starts (first-run database build, market health gate, bad config).
        foreach ($service in @("init", "market", "server")) {
            $serviceLog = Join-Path $tempLogs ("docker-compose-{0}.log" -f $service)
            $output = Invoke-Native "docker" @("compose", "logs", "--no-color", "--tail", "4000", $service)
            if ($script:NativeExitCode -eq 0 -and $output) {
                $output | Out-File -FilePath $serviceLog -Encoding utf8
            }
        }

        Write-Host "  Building the report inside a temporary container..."
        $containerArguments = @(
            "run", "--rm", "--entrypoint", "node",
            "-v", ($repoRoot + ":/hostrepo:ro"),
            "-v", ($tempRoot + ":/hosttmp"),
            "evejs-local",
            "/hostrepo/tools/ErrorReport/collect-error-report.js",
            "--root", "/hostrepo",
            "--logs-dir", "/hosttmp/logs",
            "--out", "/hosttmp/report.zip",
            "--hours", $Hours,
            "--no-prompt"
        )
        if ($Note) { $containerArguments += @("--note", $Note) }
        & docker @containerArguments
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  The collector failed inside the container (see above)." -ForegroundColor Red
            exit 1
        }
        Move-Item -Path (Join-Path $tempRoot "report.zip") -Destination $zipPath -Force
    } finally {
        Pop-Location
        Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------------- finish
if (Test-Path $zipPath) {
    Write-Host ""
    Write-Host ("  Report ready: {0}" -f $zipPath) -ForegroundColor Green
    Write-Host "  Upload this file to the EvEJS team (for example the Discord bug channel)."
    if (-not $NoReveal -and $Host.Name -eq "ConsoleHost") {
        Start-Process explorer.exe -ArgumentList ("/select,""{0}""" -f $zipPath)
    }
} else {
    Write-Host "  No report zip was produced." -ForegroundColor Red
    exit 1
}
