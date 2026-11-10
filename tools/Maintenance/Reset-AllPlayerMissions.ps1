[CmdletBinding()]
param(
    [ValidateSet("Auto", "Docker", "Native")]
    [string]$Deployment = "Auto",
    [switch]$Yes,
    [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$resetScript = Join-Path $PSScriptRoot "reset-character-missions.js"
$nativeDatabase = Join-Path $repoRoot "_local\gameStore\gamestore.sqlite"

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments,
        [string]$FailureMessage = "Command failed"
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage (exit code $LASTEXITCODE)."
    }
}

function Test-DockerEngine {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        return $false
    }
    & docker info --format "{{.ServerVersion}}" *> $null
    return $LASTEXITCODE -eq 0
}

function Test-DockerDataVolume {
    & docker volume inspect evejs-data *> $null
    return $LASTEXITCODE -eq 0
}

function Get-DetectedDeployment {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        return "Native"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "compose.yaml") -PathType Leaf)) {
        return "Native"
    }

    $containerIDs = @(& docker compose ps -a -q server 2>$null)
    if ($LASTEXITCODE -ne 0) {
        return "Unknown"
    }
    if ($containerIDs.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace(
        ($containerIDs -join "")
    )) {
        return "Docker"
    }
    return "Native"
}

if (-not (Test-Path -LiteralPath $resetScript -PathType Leaf)) {
    throw "Mission-reset command not found: $resetScript"
}

$dockerAvailable = Test-DockerEngine
$dockerDataExists = $dockerAvailable -and (Test-DockerDataVolume)
$nativeDataExists = Test-Path -LiteralPath $nativeDatabase -PathType Leaf

if ($Deployment -eq "Auto") {
    $detectedDeployment = Get-DetectedDeployment
    if ($detectedDeployment -eq "Docker") {
        $Deployment = "Docker"
    }
    elseif ($detectedDeployment -eq "Unknown") {
        throw "Docker is installed but its engine is unavailable. Start Docker Desktop, or rerun with -Deployment Native if the native _local game store is intentionally the live one."
    }
    elseif ($nativeDataExists) {
        $Deployment = "Native"
    }
    else {
        throw "No EvEJS game database was found. Start or finish setup before resetting missions."
    }
}

if ($Deployment -eq "Docker") {
    if (-not $dockerAvailable) {
        throw "Docker mode was requested, but the Docker engine is unavailable."
    }
    if (-not $dockerDataExists) {
        throw "Docker mode was requested, but the evejs-data volume does not exist."
    }
}
elseif (-not $nativeDataExists) {
    throw "Native mode was requested, but $nativeDatabase does not exist."
}

Write-Host ""
Write-Host "  EvEJS mission reset" -ForegroundColor Cyan
Write-Host "  Deployment: $Deployment"
Write-Host ""
Write-Host "  This permanently clears every character's offered and accepted missions," -ForegroundColor Yellow
Write-Host "  mission history, decline timers, career-agent completion, Storyline progress," -ForegroundColor Yellow
Write-Host "  and Epic Arc progress. Characters, items, wallets, standings, and rewards remain." -ForegroundColor Yellow
Write-Host ""

if (-not $Yes) {
    $confirmation = Read-Host "Type RESET to continue"
    if ($confirmation -cne "RESET") {
        Write-Host "Mission reset cancelled."
        exit 0
    }
}

Push-Location $repoRoot
try {
    if ($Deployment -eq "Docker") {
        $runningServices = @(& docker compose ps --status running --services 2>$null)
        if ($LASTEXITCODE -ne 0) {
            throw "Could not inspect the EvEJS Docker services."
        }
        $serverWasRunning = $runningServices -contains "server"

        if ($serverWasRunning) {
            Write-Host "Stopping the Docker game server..."
            Invoke-CheckedCommand -FilePath "docker" -Arguments @(
                "compose", "stop", "server"
            ) -FailureMessage "Could not stop the Docker game server"
        }

        $resetCompleted = $false
        try {
            Write-Host "Resetting all persisted player missions..."
            Invoke-CheckedCommand -FilePath "docker" -Arguments @(
                "compose", "run", "--rm", "--no-deps", "-T", "--entrypoint", "node",
                "server", "/app/tools/Maintenance/reset-character-missions.js"
            ) -FailureMessage "Docker mission reset failed"
            $resetCompleted = $true
        }
        finally {
            if ($serverWasRunning -and -not $NoRestart) {
                Write-Host "Restarting the Docker game server..."
                $restartFailure = if ($resetCompleted) {
                    "Mission state was reset, but the Docker game server could not be restarted"
                }
                else {
                    "Mission reset failed, and the Docker game server also could not be restarted"
                }
                Invoke-CheckedCommand -FilePath "docker" -Arguments @(
                    "compose", "start", "server"
                ) -FailureMessage $restartFailure
            }
        }
    }
    else {
        if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
            throw "Node.js is required for a native mission reset. Install Node.js 24 or use the Docker deployment."
        }
        Write-Host "The native game server must be stopped before this command can acquire the database."
        Write-Host "Resetting all persisted player missions..."
        $env:EVEJS_GAMESTORE_DATA_DIR = Join-Path $repoRoot "_local\gameStore\data"
        Invoke-CheckedCommand -FilePath "node" -Arguments @(
            $resetScript
        ) -FailureMessage "Native mission reset failed"
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "All player mission state has been reset." -ForegroundColor Green
