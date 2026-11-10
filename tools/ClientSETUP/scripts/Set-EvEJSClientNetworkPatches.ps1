[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ClientPath,
    [string]$ClientExe,
    [ValidateSet("Apply", "Check")][string]$Mode = "Apply"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-NetworkPatchClientPath {
    if (-not (Test-Path -LiteralPath $ClientPath -PathType Container)) {
        throw "Client identity gate: configure an existing EVEJS_CLIENT_PATH in tools\ClientSETUP\scripts\EvEJSConfig.bat."
    }
    $resolved = (Resolve-Path -LiteralPath $ClientPath).Path
    $iniPath = Join-Path $resolved "start.ini"
    if (-not (Test-Path -LiteralPath $iniPath -PathType Leaf)) {
        throw "Client identity gate: missing $iniPath. Run the EveJS client setup on a separate client copy."
    }
    $values = @{}
    foreach ($line in Get-Content -LiteralPath $iniPath) {
        if ($line -match '^\s*(server|cryptoPack)\s*=(.*)$') {
            $key = $Matches[1].ToLowerInvariant()
            if ($values.ContainsKey($key)) { throw "Client identity gate: duplicate $key in $iniPath." }
            $values[$key] = $Matches[2].Trim()
        }
    }
    if ($values['server'] -ne "127.0.0.1" -or $values['cryptopack'] -cne "Placebo") {
        throw "Client identity gate: refusing this install. $iniPath must contain server = 127.0.0.1 and cryptoPack = Placebo. Do not use a live EVE install."
    }
    $expectedExe = Join-Path $resolved "bin64\exefile.exe"
    if (-not $ClientExe) { $ClientExe = $expectedExe }
    if (-not (Test-Path -LiteralPath $ClientExe -PathType Leaf) -or
        (Resolve-Path -LiteralPath $ClientExe).Path -ne $expectedExe) {
        throw "Client executable gate: EVEJS_CLIENT_EXE must be $expectedExe. Only the supported 64-bit EveJS client can be patched."
    }
    foreach ($itemPath in @($resolved, $iniPath, (Join-Path $resolved "bin64"), $expectedExe,
        (Join-Path $resolved "bin64\launchdarkly_stackless_client_sdk.pyd"))) {
        if (-not (Test-Path -LiteralPath $itemPath)) { throw "Client network patch gate: missing $itemPath. Restore the supported client build 3396210." }
        if ((Get-Item -LiteralPath $itemPath).Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Client identity gate: $itemPath is a link or junction. Use a separate, ordinary EveJS client copy."
        }
    }
    return $resolved
}

function Get-ExactPatchState {
    param([string]$Path, [object]$Recipe, [object]$UpgradeRecipe = $null)
    $file = Get-Item -LiteralPath $Path
    # Windows PowerShell can inherit PowerShell Core's module search path.
    # Hash directly so the mandatory gate does not depend on module autoload.
    $hasher = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { $sha = ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
    foreach ($variant in $Recipe.knownPatchedVariants) {
        if ($file.Length -eq $variant.size -and $sha -eq $variant.sha256) { return "already_patched" }
    }
    if ($file.Length -eq $Recipe.source.size -and $sha -eq $Recipe.source.sha256) { return "patchable_original" }
    if ($UpgradeRecipe -and $file.Length -eq $UpgradeRecipe.source.size -and $sha -eq $UpgradeRecipe.source.sha256) {
        return "upgrade_required"
    }
    throw "Client network patch gate: unsupported or changed $($Recipe.name). Restore the original client build 3396210 file, then run Play.bat again. SHA-256: $sha"
}

try {
    $clientRoot = Get-NetworkPatchClientPath
    $setupDir = Split-Path -Parent $PSScriptRoot
    $patcher = Join-Path $setupDir "blue_dll_patch.ps1"
    $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $jobs = @()
    foreach ($recipeName in @("launchdarkly_patch_recipe.json", "crash_upload_patch_recipe.json")) {
        $recipePath = Join-Path $setupDir $recipeName
        $recipe = Get-Content -LiteralPath $recipePath -Raw | ConvertFrom-Json
        if (-not $recipe.requireExactHash) { throw "Client network patch gate: $recipeName must require exact hashes. Restore the repository's patch recipe." }
        $upgradeRecipe = $null
        $upgradeRecipePath = $null
        if ($recipeName -eq "launchdarkly_patch_recipe.json") {
            $upgradeRecipePath = Join-Path $setupDir "launchdarkly_localhost_upgrade_recipe.json"
            $upgradeRecipe = Get-Content -LiteralPath $upgradeRecipePath -Raw | ConvertFrom-Json
            if (-not $upgradeRecipe.requireExactHash -or $upgradeRecipe.source.filename -cne $recipe.source.filename) {
                throw "Client network patch gate: restore the exact LaunchDarkly localhost upgrade recipe."
            }
        }
        $path = Join-Path $clientRoot ("bin64\" + $recipe.source.filename)
        $state = Get-ExactPatchState -Path $path -Recipe $recipe -UpgradeRecipe $upgradeRecipe
        if ($state -eq "upgrade_required") { $recipePath = $upgradeRecipePath }
        $jobs += [pscustomobject]@{ Path = $path; RecipePath = $recipePath; Recipe = $recipe; State = $state }
    }
    if ($Mode -eq "Apply" -and @($jobs | Where-Object State -ne "already_patched").Count -gt 0) {
        $exePath = Join-Path $clientRoot "bin64\exefile.exe"
        foreach ($process in @(Get-Process exefile -ErrorAction SilentlyContinue)) {
            if ($process.Path -eq $exePath) { throw "Client network patch gate: close the EveJS client at $exePath before applying its network patches." }
        }
    }
    foreach ($job in $jobs) {
        if ($job.State -ne "already_patched") {
            if ($Mode -eq "Check") {
                if ($job.State -eq "upgrade_required") { throw "Client network patch gate: $($job.Recipe.name) needs the localhost TLS upgrade. Run Play.bat to apply the verified upgrade." }
                throw "Client network patch gate: $($job.Recipe.name) needs its loopback patch. Run Play.bat to apply the verified patch."
            }
            $output = & $powershell -NoProfile -ExecutionPolicy Bypass -File $patcher --input $job.Path --recipe $job.RecipePath --in-place 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Client network patch gate: could not patch $($job.Recipe.name). Close the EveJS client and check write access. $($output -join ' ')" }
        }
        $state = Get-ExactPatchState -Path $job.Path -Recipe $job.Recipe
        if ($state -ne "already_patched") { throw "Client network patch gate: $($job.Recipe.name) did not retain the verified patched hash. Restore the supported build and run Play.bat." }
        Write-Host "Client network patch gate passed: $($job.Recipe.name), exact loopback patch SHA-256 verified."
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
