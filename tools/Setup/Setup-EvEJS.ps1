<#
.SYNOPSIS
    EvEJS one-stop setup.

.DESCRIPTION
    Runs the whole first-time setup in the one order that works, and can be
    re-run at any time: every phase checks the real state on disk first and only
    does work when something is actually missing.

    This exists because the setup steps have ordering dependencies that used to
    be tribal knowledge -- most importantly, certificates must be generated
    before the client wizard can trust them, and the Node packages must be
    installed before certificates can be generated at all.

    Nothing here assumes the server is localhost-only. Host and bind settings in
    config\server.json are never changed by setup, so a LAN / multiplayer host
    keeps its configuration. The server's versioned config loader owns seeding
    and migration when configuration files are missing or from an older release.

.EXAMPLE
    .\SetupEveJS.bat
    .\SetupEveJS.bat -Status
    .\SetupEveJS.bat -Mode native -SkipClient
#>
[CmdletBinding()]
param(
  [ValidateSet("auto", "native", "docker")]
  [string]$Mode = "auto",

  # Report what each phase would do without changing anything.
  [switch]$Status,

  # Never prompt. Optional phases are skipped instead of asked about.
  [switch]$NonInteractive,

  # Skip the standalone market (native only -- Docker requires it).
  [switch]$SkipMarket,

  # Skip EVE client preparation (for a server-only or headless host).
  [switch]$SkipClient,

  # Run only these phase ids.
  [string[]]$Only,

  # Run everything except these phase ids.
  [string[]]$Skip
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 1.0

# SetupEveJS.bat launches Windows PowerShell, but it can inherit a PSModulePath
# from a PowerShell 7 parent (typing .\SetupEveJS.bat in a PowerShell 7
# terminal). Command autoload then tries PowerShell 7's Microsoft.PowerShell.Security
# first, Get-PfxCertificate fails, and every certificate check reads as missing.
# Import the security module shipped with this host, as Install-EvEJSCerts.ps1 does.
function Import-HostPowerShellSecurityModule {
  $securityModuleManifestPath = Join-Path `
    $PSHOME `
    "Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1"

  if (-not (Test-Path -LiteralPath $securityModuleManifestPath -PathType Leaf)) {
    throw "The built-in Microsoft.PowerShell.Security module was not found for this PowerShell host at $securityModuleManifestPath."
  }

  Import-Module `
    -Name $securityModuleManifestPath `
    -Force `
    -ErrorAction Stop
  Get-Command `
    -Name "Get-PfxCertificate" `
    -CommandType Cmdlet `
    -ErrorAction Stop | Out-Null
}

Import-HostPowerShellSecurityModule

# ═══════════════════════════════════════════════════════════════════════════════
# PATHS
# ═══════════════════════════════════════════════════════════════════════════════
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

$ClientSetupScripts = Join-Path $RepoRoot "tools\ClientSETUP\scripts"
$InstallCertsPs1 = Join-Path $ClientSetupScripts "Install-EvEJSCerts.ps1"
$FirewallPs1 = Join-Path $ClientSetupScripts "Set-EvEJSFirewall.ps1"
$ClientSetupBat = Join-Path $RepoRoot "tools\ClientSETUP\StartClientSetup.bat"
$LauncherConfig = Join-Path $ClientSetupScripts "EvEJSConfig.bat"
$CreateDatabaseBat = Join-Path $RepoRoot "tools\DatabaseCreator\CreateDatabase.bat"
$InstallRustBat = Join-Path $RepoRoot "tools\InstallRustForMarket.bat"
$BuildMarketSeedBat = Join-Path $RepoRoot "BuildMarketSeed.bat"
$BuildMarketSeedV2Bat = Join-Path $RepoRoot "tools\market-seederv2\BuildMarketSeedV2.bat"
$BuildMarketSeedV3Bat = Join-Path $RepoRoot "tools\market-seederv3\BuildMarketSeedV3.bat"

# The certificates live in the data root's certs folder: EVEJS_DATA_ROOT, else <repo>\_local,
# so <repo>\_local\certs on a native install. compose.yaml mounts that folder into the
# container, so Docker uses it too. The rule is in server\src\config\certificateFiles.js, and
# Sync-CertificateFolder runs that file before the certificate checks.
$CertificateFilesScript = Join-Path $RepoRoot "server\src\config\certificateFiles.js"
function Set-CertificatePaths {
  param([string]$CertDir)

  $script:CertDir = $CertDir
  $script:CaCertPath = Join-Path $CertDir "xmpp-ca-cert.pem"
  $script:CaKeyPath = Join-Path $CertDir "xmpp-ca-key.pem"
  $script:XmppCertPath = Join-Path $CertDir "xmpp-dev-cert.pem"
  $script:XmppKeyPath = Join-Path $CertDir "xmpp-dev-key.pem"
  $script:GatewayCertDir = $CertDir
  $script:GatewayCertPath = Join-Path $CertDir "gateway-dev-cert.pem"
  $script:GatewayKeyPath = Join-Path $CertDir "gateway-dev-key.pem"
  $script:GatewayDnsCertPath = Join-Path $CertDir "gateway-dns-cert.pem"
  $script:GatewayDnsKeyPath = Join-Path $CertDir "gateway-dns-key.pem"
}
$DataRoot = if ($env:EVEJS_DATA_ROOT) { [System.IO.Path]::GetFullPath($env:EVEJS_DATA_ROOT) } else { Join-Path $RepoRoot "_local" }
Set-CertificatePaths -CertDir (Join-Path $DataRoot "certs")

$GameStoreManifest = Join-Path $RepoRoot "_local\gameStore\manifest.json"

$NativeMarketDatabase = Join-Path $RepoRoot "externalservices\market-server\data\generated\market.sqlite"

# Must match LOCAL_TLS_DNS_ALT_NAMES in
# server\src\_secondary\express\localTlsCertificate.js and $gatewayDnsNames in
# tools\ClientSETUP\scripts\Install-EvEJSCerts.ps1.
$GatewayDnsNames = @(
  "app.launchdarkly.com",
  "clientstream.launchdarkly.com",
  "clientsdk.launchdarkly.com",
  "dev-public-gateway.evetech.net",
  "events.launchdarkly.com",
  "mobile.launchdarkly.com",
  "public-gateway.evetech.net",
  "sdk.launchdarkly.com",
  "sentry.io",
  "stream.launchdarkly.com",
  "localhost"
)
$GatewayIpNames = @("127.0.0.1")

$MinimumNodeMajor = 20

# Where the Docker volume keeps persistent state (see docker\entrypoint.sh).
$DockerDataRoot = "/var/lib/evejs"

# ═══════════════════════════════════════════════════════════════════════════════
# OUTPUT
# ═══════════════════════════════════════════════════════════════════════════════
function Write-Banner {
  param([string]$Text)
  Write-Host ""
  Write-Host "  ============================================================" -ForegroundColor DarkCyan
  Write-Host "    $Text" -ForegroundColor Cyan
  Write-Host "  ============================================================" -ForegroundColor DarkCyan
  Write-Host ""
}

function Write-Info {
  param([string]$Text)
  Write-Host "  $Text" -ForegroundColor Gray
}

function Write-Detail {
  param([string]$Text)
  Write-Host "        $Text" -ForegroundColor DarkGray
}

function Write-PhaseResult {
  param(
    [string]$Label,
    [string]$Title,
    [string]$Detail,
    [string]$Color
  )
  Write-Host ("  {0,-8}" -f $Label) -ForegroundColor $Color -NoNewline
  Write-Host $Title -ForegroundColor White
  if ($Detail) {
    Write-Detail $Detail
  }
}

# ═══════════════════════════════════════════════════════════════════════════════
# SMALL HELPERS
# ═══════════════════════════════════════════════════════════════════════════════
function Get-CommandPath {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) {
      return $command.Source
    }
  }
  return $null
}

function Invoke-Native {
  <#
    Run an external command and return @{ ExitCode; Output }.

    Two things this has to get right, because both have bitten this script:
      * $ErrorActionPreference is Stop for the rest of the file, which would
        turn any stderr line from a native command into a terminating error.
        npm and docker both write warnings to stderr on a successful run, so
        that has to be relaxed here.
      * The command's stdout must not leak into the caller's return value, so
        it is either captured or sent explicitly to the host.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory,
    [switch]$ShowOutput
  )

  $ErrorActionPreference = "Continue"
  $previousLocation = Get-Location
  if ($WorkingDirectory) {
    Set-Location -LiteralPath $WorkingDirectory
  }
  try {
    # "$_" flattens the merged stderr records to plain strings. Without it a
    # routine npm or docker warning is rendered as a red PowerShell error block
    # complete with a stack trace, which reads as a crash to anyone following
    # the setup for the first time.
    if ($ShowOutput) {
      & $FilePath @Arguments 2>&1 | ForEach-Object { "$_" } | Out-Host
      return @{ ExitCode = $LASTEXITCODE; Output = "" }
    }
    $captured = (& $FilePath @Arguments 2>&1 | ForEach-Object { "$_" }) -join [Environment]::NewLine
    return @{ ExitCode = $LASTEXITCODE; Output = "$captured" }
  } catch {
    return @{ ExitCode = 1; Output = "$($_.Exception.Message)" }
  } finally {
    Set-Location -LiteralPath $previousLocation
  }
}

function Invoke-Tool {
  # Run a command, show its output, return the exit code.
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory
  )
  $result = Invoke-Native -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory -ShowOutput
  return $result.ExitCode
}

function Invoke-ToolQuiet {
  # Run a command silently, return the exit code. For probes.
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory
  )
  $result = Invoke-Native -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $WorkingDirectory
  return $result.ExitCode
}

function Read-Choice {
  param(
    [string]$Question,
    [string[]]$Options,
    [int]$DefaultIndex = 0
  )

  if ($NonInteractive) {
    return $DefaultIndex
  }

  Write-Host ""
  Write-Host "  $Question" -ForegroundColor Yellow
  for ($index = 0; $index -lt $Options.Count; $index++) {
    $marker = " "
    if ($index -eq $DefaultIndex) {
      $marker = "*"
    }
    Write-Host ("    [{0}]{1} {2}" -f ($index + 1), $marker, $Options[$index])
  }
  Write-Host ""
  $answer = Read-Host "  Choose [1-$($Options.Count)]"
  if (-not $answer) {
    return $DefaultIndex
  }
  $parsed = 0
  if ([int]::TryParse($answer, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le $Options.Count) {
    return ($parsed - 1)
  }
  return $DefaultIndex
}

function Read-YesNo {
  param(
    [string]$Question,
    [bool]$DefaultYes = $true
  )

  if ($NonInteractive) {
    return $DefaultYes
  }

  $suffix = "[y/N]"
  if ($DefaultYes) {
    $suffix = "[Y/n]"
  }
  Write-Host ""
  $answer = Read-Host "  $Question $suffix"
  if (-not $answer) {
    return $DefaultYes
  }
  return ($answer -match '^(y|yes)$')
}

function Get-LauncherConfigValue {
  <#
    Read one `set "NAME=value"` entry out of EvEJSConfig.bat and expand the
    %EVEJS_REPO_ROOT% placeholder. Parsing beats running the batch file: this
    has to work when the config does not exist yet.
  #>
  param([string]$Name)

  if (-not (Test-Path $LauncherConfig)) {
    return $null
  }

  foreach ($line in Get-Content -LiteralPath $LauncherConfig) {
    if ($line -match ('^\s*set\s+"' + [regex]::Escape($Name) + '=(.*)"\s*$')) {
      $value = $Matches[1]
      $value = $value -replace '%EVEJS_REPO_ROOT%', [regex]::Escape($RepoRoot).Replace('\\', '\')
      if (-not $value) {
        return $null
      }
      return $value
    }
  }
  return $null
}

function Get-ClientPath {
  $configured = Get-LauncherConfigValue -Name "EVEJS_CLIENT_PATH"
  if ($configured -and (Test-Path $configured)) {
    return (Resolve-Path -LiteralPath $configured).Path
  }
  return $null
}

# ═══════════════════════════════════════════════════════════════════════════════
# CERTIFICATE INSPECTION
# ═══════════════════════════════════════════════════════════════════════════════
function Get-CertificateOrNull {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return $null
  }
  try {
    return Get-PfxCertificate -FilePath $Path
  } catch {
    return $null
  }
}

function Test-IssuedByCa {
  param([string]$LeafPath)

  $leaf = Get-CertificateOrNull -Path $LeafPath
  $ca = Get-CertificateOrNull -Path $CaCertPath
  if (-not $leaf -or -not $ca) {
    return $false
  }
  if ([string]::Equals($leaf.Subject, $leaf.Issuer, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $false
  }
  return [string]::Equals($leaf.Issuer, $ca.Subject, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-GatewayCertificateCurrent {
  <#
    The server rebuilds the gateway leaf on boot unless its SAN set matches
    exactly, so "current" here means the same thing it means to the server.
  #>
  $node = Get-CommandPath -Names @("node.exe", "node")
  if (-not $node) { return $false }
  $builder = Join-Path $ClientSetupScripts "build-gateway-cert.js"
  foreach ($leaf in @(
    @{ Cert = $GatewayCertPath; Key = $GatewayKeyPath; DnsOnly = $false },
    @{ Cert = $GatewayDnsCertPath; Key = $GatewayDnsKeyPath; DnsOnly = $true }
  )) {
    if (-not (Test-Path -LiteralPath $leaf.Cert) -or -not (Test-Path -LiteralPath $leaf.Key)) { return $false }
    if (-not (Test-IssuedByCa -LeafPath $leaf.Cert)) { return $false }
    $arguments = @($builder, '--check-only', '--ca-cert', $CaCertPath, '--ca-key', $CaKeyPath,
      '--out-cert', $leaf.Cert, '--out-key', $leaf.Key, '--dns', ($GatewayDnsNames -join ','))
    if ($leaf.DnsOnly) { $arguments += '--dns-only' }
    else { $arguments += @('--ip', ($GatewayIpNames -join ',')) }
    $verified = Invoke-Native -FilePath $node -Arguments $arguments
    if ($verified.ExitCode -ne 0) { return $false }
  }
  return $true
}

function Test-CaTrustedInRootStore {
  $ca = Get-CertificateOrNull -Path $CaCertPath
  if (-not $ca) {
    return $false
  }
  $match = Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue |
    Where-Object { $_.Thumbprint -eq $ca.Thumbprint }
  return [bool]$match
}

function Test-ConstrainedCaFiles {
  $builder = Join-Path $ClientSetupScripts "build-gateway-cert.js"
  $node = Get-CommandPath -Names @("node.exe", "node")
  if (-not $node) { return $false }
  $probe = Invoke-Native -FilePath $node -Arguments @($builder, "--check-only", "--ca-only", "--ca-cert", $CaCertPath, "--ca-key", $CaKeyPath)
  return ($probe.ExitCode -eq 0)
}

function Sync-CertificateFolder {
  <#
    Until 2026-09-21 the certificates lived in server\certs and
    server\src\_secondary\express\certs. Run before a certificate check so a CA
    made there is found, not replaced: certificateFiles.js copies any certificate
    file the certs folder does not have yet from those folders, and prints the
    folder, which the checks then use. It never overwrites a file, and the server
    does the same when it starts. Without Node the paths stay as they are and the
    checks fail as before.
  #>
  $node = Get-CommandPath -Names @("node.exe", "node")
  if (-not $node) { return }
  $printed = Invoke-Native -FilePath $node -Arguments @($CertificateFilesScript)
  if ($printed.ExitCode -ne 0) { return }
  try {
    $folder = $printed.Output | ConvertFrom-Json
  } catch {
    return
  }
  if ($folder.certDir) { Set-CertificatePaths -CertDir ([string]$folder.certDir) }
  foreach ($copied in @($folder.copied)) {
    if ($copied) { Write-Info "Copied $copied from the old certificate folder" }
  }
}

function Get-OfflineClientStatus {
  $clientPath = Get-ClientPath
  if (-not $clientPath) { return @{ Ok = $false; Detail = "configure an EveJS client copy first" } }
  $identity = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FirewallPs1, "-ClientPath", $clientPath, "-Mode", "Plan")
  if ($identity.ExitCode -ne 0) { return @{ Ok = $false; Detail = $identity.Output.Trim() } }
  $resourceScript = Join-Path $ClientSetupScripts "Test-EvEJSResources.ps1"
  $resources = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $resourceScript, "-ClientPath", $clientPath)
  if ($resources.ExitCode -ne 0) { return @{ Ok = $false; Detail = $resources.Output.Trim() } }
  $patchTool = Join-Path $ClientSetupScripts "Set-EvEJSClientNetworkPatches.ps1"
  $clientExe = Get-LauncherConfigValue -Name "EVEJS_CLIENT_EXE"
  if (-not $clientExe) { $clientExe = Join-Path $clientPath "bin64\exefile.exe" }
  $patches = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $patchTool, "-Mode", "Check", "-ClientPath", $clientPath, "-ClientExe", $clientExe)
  if ($patches.ExitCode -ne 0) { return @{ Ok = $false; Detail = $patches.Output.Trim() } }
  $certs = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $InstallCertsPs1, "-CheckOnly", "-ClientPath", $clientPath)
  return @{ Ok = ($certs.ExitCode -eq 0); Detail = $certs.Output.Trim() }
}

function Get-ClientCaBundlePaths {
  param([string]$ClientPath)
  if (-not $ClientPath) {
    return @()
  }
  return @(Get-ChildItem -LiteralPath $ClientPath -Recurse -Filter "cacert.pem" -File -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName })
}

function Test-CaInClientBundles {
  param([string]$ClientPath)

  if (-not (Test-Path $CaCertPath)) {
    return $false
  }
  $bundles = Get-ClientCaBundlePaths -ClientPath $ClientPath
  if ($bundles.Count -eq 0) {
    return $false
  }

  $caRaw = (Get-Content -LiteralPath $CaCertPath -Raw).Trim()
  foreach ($bundle in $bundles) {
    $content = Get-Content -LiteralPath $bundle -Raw
    if (-not $content -or -not $content.Contains($caRaw)) {
      return $false
    }
  }
  return $true
}

# ═══════════════════════════════════════════════════════════════════════════════
# DOCKER HELPERS
# ═══════════════════════════════════════════════════════════════════════════════
function Get-DockerPath {
  return Get-CommandPath -Names @("docker.exe", "docker")
}

function Invoke-Compose {
  param(
    [string[]]$Arguments,
    [switch]$Quiet
  )
  $docker = Get-DockerPath
  if (-not $docker) {
    return 1
  }
  $composeArguments = @("compose") + $Arguments
  if ($Quiet) {
    return (Invoke-ToolQuiet -FilePath $docker -Arguments $composeArguments -WorkingDirectory $RepoRoot)
  }
  return (Invoke-Tool -FilePath $docker -Arguments $composeArguments -WorkingDirectory $RepoRoot)
}

function Test-DockerLinuxEngine {
  $docker = Get-DockerPath
  if (-not $docker) {
    return $false
  }
  $result = Invoke-Native -FilePath $docker -Arguments @("info", "--format", "{{.OSType}}")
  return ($result.ExitCode -eq 0 -and $result.Output.Trim() -eq "linux")
}

function Test-DockerImageExists {
  $docker = Get-DockerPath
  if (-not $docker) {
    return $false
  }
  return ((Invoke-ToolQuiet -FilePath $docker -Arguments @("image", "inspect", "evejs-local")) -eq 0)
}

function Test-DockerVolumeFile {
  <#
    Probe for a file inside the persistent evejs-data volume by running a
    throwaway shell in the project image.
  #>
  param([string]$RelativePath)

  if (-not (Test-DockerImageExists)) {
    return $false
  }
  $target = "$DockerDataRoot/$RelativePath"
  $exit = Invoke-Compose -Quiet -Arguments @(
    "run", "--rm", "--no-deps", "--entrypoint", "sh", "init", "-c", "test -s '$target'"
  )
  return ($exit -eq 0)
}

function Get-ComposeServiceHealth {
  param([string]$Service)

  $docker = Get-DockerPath
  if (-not $docker) {
    return "missing"
  }

  $ids = Invoke-Native -FilePath $docker -Arguments @("compose", "ps", "--quiet", $Service) -WorkingDirectory $RepoRoot
  if ($ids.ExitCode -ne 0) {
    return "missing"
  }
  $containerId = ($ids.Output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
  if (-not $containerId) {
    return "missing"
  }

  $health = Invoke-Native -FilePath $docker -Arguments @(
    "inspect",
    "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}",
    $containerId.Trim()
  )
  if ($health.ExitCode -ne 0) {
    return "missing"
  }
  return $health.Output.Trim()
}

function Test-ComposeStackHealthy {
  $market = Get-ComposeServiceHealth -Service "market"
  $server = Get-ComposeServiceHealth -Service "server"
  return ($market -eq "healthy" -and $server -eq "healthy")
}

function Wait-ComposeStackHealthy {
  param([int]$TimeoutSeconds = 600)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastReport = ""
  while ((Get-Date) -lt $deadline) {
    $market = Get-ComposeServiceHealth -Service "market"
    $server = Get-ComposeServiceHealth -Service "server"

    if ($market -eq "healthy" -and $server -eq "healthy") {
      return $true
    }
    $report = "market=$market server=$server"
    if ($report -ne $lastReport) {
      Write-Detail "waiting: $report"
      $lastReport = $report
    }
    Start-Sleep -Seconds 5
  }
  return $false
}

# ═══════════════════════════════════════════════════════════════════════════════
# PHASE DEFINITIONS
#
# Every phase answers two questions with no stored state: is this already done
# (Check), and how do I do it (Fix). Deriving status from the filesystem is what
# makes the script safe to re-run and safe to interrupt.
# ═══════════════════════════════════════════════════════════════════════════════
function New-Phase {
  param(
    [string]$Id,
    [string]$Title,
    [string[]]$Modes,
    [scriptblock]$Check,
    [scriptblock]$Fix,
    [switch]$Optional
  )
  return [pscustomobject]@{
    Id = $Id
    Title = $Title
    Modes = $Modes
    Check = $Check
    Fix = $Fix
    Optional = [bool]$Optional
  }
}

function Get-AllPhases {
  $phases = @()

  # ── Node.js ────────────────────────────────────────────────────────────────
  $phases += New-Phase -Id "node" -Title "Node.js runtime" -Modes @("native") -Check {
    $node = Get-CommandPath -Names @("node.exe", "node")
    if (-not $node) {
      return @{ Ok = $false; Detail = "Node.js is not on PATH" }
    }
    $version = (& $node --version 2>$null)
    if ("$version" -match '^v(\d+)\.') {
      $major = [int]$Matches[1]
      if ($major -lt $MinimumNodeMajor) {
        return @{ Ok = $false; Detail = "found $version, need v$MinimumNodeMajor or newer" }
      }
      return @{ Ok = $true; Detail = "$version" }
    }
    return @{ Ok = $false; Detail = "could not read the Node.js version" }
  } -Fix {
    Write-Host ""
    Write-Host "  Node.js LTS is required and cannot be installed automatically." -ForegroundColor Yellow
    Write-Host "  Install it from https://nodejs.org, close this window, and run" -ForegroundColor Yellow
    Write-Host "  SetupEveJS.bat again." -ForegroundColor Yellow
    Write-Host ""
    return $false
  }

  # ── Setup-tool packages ────────────────────────────────────────────────────
  $phases += New-Phase -Id "root-deps" -Title "Setup packages (certificate tooling)" -Modes @("native") -Check {
    $node = Get-CommandPath -Names @("node.exe", "node")
    if (-not $node) {
      return @{ Ok = $false; Detail = "Node.js is not available yet" }
    }
    $exit = Invoke-ToolQuiet -FilePath $node -Arguments @("-e", "require('node-forge')") -WorkingDirectory $RepoRoot
    if ($exit -eq 0) {
      return @{ Ok = $true; Detail = "node-forge is installed" }
    }
    return @{ Ok = $false; Detail = "node-forge is missing (certificates cannot be generated without it)" }
  } -Fix {
    $npm = Get-CommandPath -Names @("npm.cmd", "npm")
    if (-not $npm) {
      Write-Info "npm was not found on PATH."
      return $false
    }
    $arguments = @("install", "--no-audit", "--no-fund")
    if (Test-Path (Join-Path $RepoRoot "package-lock.json")) {
      $arguments = @("ci", "--no-audit", "--no-fund")
    }
    Write-Info "Running npm $($arguments[0]) in the project root ..."
    $exit = Invoke-Tool -FilePath $npm -Arguments $arguments -WorkingDirectory $RepoRoot
    return ($exit -eq 0)
  }

  # ── Certificates (server side only -- no EVE client needed) ────────────────
  $phases += New-Phase -Id "certs" -Title "Local TLS certificates" -Modes @("native") -Check {
    Sync-CertificateFolder
    if (-not (Test-ConstrainedCaFiles)) {
      return @{ Ok = $false; Detail = "CA rotation required: missing, expired or unconstrained per-install CA" }
    }
    if (-not (Test-Path $CaCertPath) -or -not (Test-Path $CaKeyPath)) {
      return @{ Ok = $false; Detail = "the local certificate authority has not been created yet" }
    }
    if (-not (Test-Path $XmppCertPath) -or -not (Test-Path $XmppKeyPath) -or -not (Test-IssuedByCa -LeafPath $XmppCertPath)) {
      return @{ Ok = $false; Detail = "the chat (XMPP) certificate is missing or was not signed by the local CA" }
    }
    if (-not (Test-GatewayCertificateCurrent)) {
      return @{ Ok = $false; Detail = "the loopback or DNS gateway certificate is missing or out of date" }
    }
    $ca = Get-CertificateOrNull -Path $CaCertPath
    return @{ Ok = $true; Detail = "CA $($ca.Thumbprint)" }
  } -Fix {
    if (-not (Test-Path $InstallCertsPs1)) {
      Write-Info "Install-EvEJSCerts.ps1 is missing from this copy."
      return $false
    }
    # Generate the server-side material only. Trusting the CA in Windows and in
    # the client's bundles belongs to the client phase, which runs later and
    # needs these files to already exist -- that ordering is the whole point.
    try {
      & $InstallCertsPs1 -RotateCa -ServerFilesOnly | Out-Host
      return $true
    } catch {
      Write-Info "Certificate generation failed: $($_.Exception.Message)"
      return $false
    }
  }

  # ── Server packages ────────────────────────────────────────────────────────
  $phases += New-Phase -Id "server-deps" -Title "Server packages" -Modes @("native") -Check {
    $express = Join-Path $RepoRoot "server\node_modules\express\package.json"
    $sqlite = Join-Path $RepoRoot "server\node_modules\better-sqlite3\package.json"
    if ((Test-Path $express) -and (Test-Path $sqlite)) {
      return @{ Ok = $true; Detail = "installed" }
    }
    return @{ Ok = $false; Detail = "server\node_modules is missing or incomplete" }
  } -Fix {
    $npm = Get-CommandPath -Names @("npm.cmd", "npm")
    if (-not $npm) {
      Write-Info "npm was not found on PATH."
      return $false
    }
    Write-Info "Running npm ci in the server directory (this builds native modules and can take a few minutes) ..."
    $exit = Invoke-Tool -FilePath $npm -Arguments @("ci", "--no-audit", "--no-fund") -WorkingDirectory (Join-Path $RepoRoot "server")
    return ($exit -eq 0)
  }

  # ── Game database ──────────────────────────────────────────────────────────
  $phases += New-Phase -Id "gamedb" -Title "Game database (static data)" -Modes @("native") -Check {
    if (Test-Path $GameStoreManifest) {
      return @{ Ok = $true; Detail = "_local\gameStore" }
    }
    return @{ Ok = $false; Detail = "not generated yet (downloads the EVE static data on first run)" }
  } -Fix {
    if (-not (Test-Path $CreateDatabaseBat)) {
      Write-Info "tools\DatabaseCreator\CreateDatabase.bat is missing from this copy."
      return $false
    }
    Write-Info "Building the game database. The first run downloads roughly 80 MB and takes a while ..."
    $exit = Invoke-Tool -FilePath $CreateDatabaseBat -WorkingDirectory $RepoRoot
    return ($exit -eq 0)
  }

  $phases += New-Phase -Id "gamedb" -Title "Game database (static data)" -Modes @("docker") -Check {
    if (Test-DockerVolumeFile -RelativePath "gameStore/manifest.json") {
      return @{ Ok = $true; Detail = "evejs-data volume" }
    }
    return @{ Ok = $false; Detail = "not generated yet in the evejs-data volume" }
  } -Fix {
    Write-Info "Initializing persistent game data in the Docker volume ..."
    $exit = Invoke-Compose -Arguments @("run", "--rm", "init")
    return ($exit -eq 0)
  }

  # ── Content packs ──────────────────────────────────────────────────────────
  # Runs after the game database in both modes: installing a pack builds the
  # effective dungeon authority to check for collisions, which needs the base
  # tables to exist. Optional, because most installations have no packs.
  # ── Market ─────────────────────────────────────────────────────────────────
  $phases += New-Phase -Id "market" -Title "Standalone market" -Modes @("native") -Optional -Check {
    if (Test-Path $NativeMarketDatabase) {
      return @{ Ok = $true; Detail = "market.sqlite is built" }
    }
    return @{ Ok = $false; Detail = "not built (optional -- you can log in and play without it)" }
  } -Fix {
    Write-Host ""
    Write-Host "  The native market needs the Rust toolchain and the MSVC C++ build" -ForegroundColor Yellow
    Write-Host "  tools. That install is large and can take a long time." -ForegroundColor Yellow
    if (-not (Read-YesNo -Question "Set the market up now?" -DefaultYes $false)) {
      Write-Info "Skipped. Run tools\InstallRustForMarket.bat and a seed builder later -- see doc\MARKET_SETUP.md."
      return $true
    }
    if (Test-Path $InstallRustBat) {
      Write-Info "Installing the Rust toolchain ..."
      $exit = Invoke-Tool -FilePath $InstallRustBat -WorkingDirectory $RepoRoot
      if ($exit -ne 0) {
        return $false
      }
    }
    $choice = Read-Choice -Question "Which market do you want?" -DefaultIndex 0 -Options @(
      "Synthetic starter market (v1, Jita + New Caldari) -- fast, recommended",
      "Live Tranquility snapshot (v2) -- downloads a large snapshot",
      "Cost-priced Jita hub plus the NPC catalog (v3) -- blueprints and skillbooks included"
    )
    $seedLauncher = $BuildMarketSeedBat
    $seedLabel = "BuildMarketSeed.bat"
    switch ($choice) {
      1 {
        $seedLauncher = $BuildMarketSeedV2Bat
        $seedLabel = "tools\market-seederv2\BuildMarketSeedV2.bat"
      }
      2 {
        $seedLauncher = $BuildMarketSeedV3Bat
        $seedLabel = "tools\market-seederv3\BuildMarketSeedV3.bat"
      }
    }
    if (-not (Test-Path $seedLauncher)) {
      Write-Info "$seedLabel is missing from this copy."
      return $false
    }
    if ($choice -eq 1) {
      Write-Info "Opening the v2 snapshot seed builder. Choose [1] to build the latest snapshot."
    } elseif ($choice -eq 2) {
      # Only the native v3 path needs this said out loud: a v3 build never
      # downloads, and its launcher keeps the download as an explicit menu entry.
      # (The Docker rebuild caches the snapshot itself, so it says nothing there.)
      Write-Host ""
      Write-Host "  The v3 builder opens next. Its first build needs the Tranquility" -ForegroundColor Yellow
      Write-Host "  snapshot cached once, because a build never downloads:" -ForegroundColor Yellow
      Write-Host "    1. choose [C] Download the TQ snapshot and let it finish" -ForegroundColor Yellow
      Write-Host "    2. the builder closes, so open it again from" -ForegroundColor Yellow
      Write-Host "       tools\market-seederv3\BuildMarketSeedV3.bat" -ForegroundColor Yellow
      Write-Host "    3. choose [1] Build the Jita index seed" -ForegroundColor Yellow
      Write-Host "  Already have the snapshot? Just choose [1]." -ForegroundColor Yellow
      Write-Host ""
    } else {
      Write-Info "Opening the market seed builder. Choose 'Jita + New Caldari' if you are unsure."
    }
    $exit = Invoke-Tool -FilePath $seedLauncher -WorkingDirectory $RepoRoot
    return ($exit -eq 0)
  }

  $phases += New-Phase -Id "market" -Title "Market database" -Modes @("docker") -Check {
    if (Test-DockerVolumeFile -RelativePath "market/market.sqlite") {
      return @{ Ok = $true; Detail = "evejs-data volume" }
    }
    return @{ Ok = $false; Detail = "no market database -- the server cannot start without one" }
  } -Fix {
    $choice = Read-Choice -Question "Which market do you want?" -DefaultIndex 0 -Options @(
      "Synthetic starter market (v1, Jita + New Caldari) -- fast, recommended",
      "Live Tranquility snapshot (v2) -- downloads a large snapshot",
      "Cost-priced Jita hub plus the NPC catalog (v3) -- blueprints and skillbooks included"
    )
    if ($choice -eq 0) {
      Write-Info "Building the v1 starter market ..."
      $exit = Invoke-Compose -Arguments @(
        "run", "--rm", "--no-deps", "market-tools", "rebuild", "v1", "--preset", "jita_new_caldari"
      )
    } elseif ($choice -eq 1) {
      Write-Info "Building the v2 snapshot market ..."
      $exit = Invoke-Compose -Arguments @(
        "run", "--rm", "--no-deps", "market-tools", "rebuild", "v2",
        "--order-filter", "market-scope-with-npc", "--market-solar-system-id", "30000142"
      )
    } else {
      # v3 takes no preset and no order filter. The rebuild caches the Tranquility
      # snapshot itself before building, so there is no separate download step here.
      Write-Info "Building the v3 cost-priced Jita market with the NPC catalog ..."
      $exit = Invoke-Compose -Arguments @(
        "run", "--rm", "--no-deps", "market-tools", "rebuild", "v3"
      )
    }
    return ($exit -eq 0)
  }

  # ── Docker-only phases ─────────────────────────────────────────────────────
  $phases += New-Phase -Id "docker" -Title "Docker engine" -Modes @("docker") -Check {
    if (-not (Get-DockerPath)) {
      return @{ Ok = $false; Detail = "the docker command is not on PATH" }
    }
    if (-not (Test-DockerLinuxEngine)) {
      return @{ Ok = $false; Detail = "Docker is not running, or is not in Linux containers mode" }
    }
    return @{ Ok = $true; Detail = "Linux containers" }
  } -Fix {
    Write-Host ""
    Write-Host "  Start Docker Desktop and make sure it is set to Linux containers," -ForegroundColor Yellow
    Write-Host "  then run SetupEveJS.bat again." -ForegroundColor Yellow
    Write-Host ""
    return $false
  }

  $phases += New-Phase -Id "image" -Title "Docker image" -Modes @("docker") -Check {
    if (Test-DockerImageExists) {
      return @{ Ok = $true; Detail = "evejs-local" }
    }
    return @{ Ok = $false; Detail = "the evejs-local image has not been built" }
  } -Fix {
    Write-Info "Building the evejs-local image. This compiles the Rust market and takes a while ..."
    $exit = Invoke-Compose -Arguments @("build", "init")
    return ($exit -eq 0)
  }

  $phases += New-Phase -Id "up" -Title "Backend services" -Modes @("docker") -Check {
    if (Test-ComposeStackHealthy) {
      return @{ Ok = $true; Detail = "market and server are healthy" }
    }
    return @{ Ok = $false; Detail = "the containers are not running or not healthy yet" }
  } -Fix {
    Write-Info "Starting the backend ..."
    $exit = Invoke-Compose -Arguments @("up", "--detach")
    if ($exit -ne 0) {
      return $false
    }
    Write-Info "Waiting for the containers to report healthy ..."
    return (Wait-ComposeStackHealthy -TimeoutSeconds 900)
  }

  $phases += New-Phase -Id "certs" -Title "Local TLS certificates" -Modes @("docker") -Check {
    Sync-CertificateFolder
    if (-not (Test-ConstrainedCaFiles)) {
      return @{ Ok = $false; Detail = "CA rotation required before starting Docker: run the certificate installer with -RotateCa" }
    }
    if ((Test-Path $CaCertPath) -and (Test-Path $GatewayCertPath)) {
      $ca = Get-CertificateOrNull -Path $CaCertPath
      if ($ca) {
        return @{ Ok = $true; Detail = "CA $($ca.Thumbprint)" }
      }
    }
    return @{ Ok = $false; Detail = "the certificates are not in $CertDir yet" }
  } -Fix {
    # Rotate before starting the container: the server must refuse an old CA.
    # compose.yaml mounts this folder into the container as its certs folder.
    if (-not (Get-CommandPath -Names @("node.exe", "node"))) {
      Write-Info "Install the host Node.js certificate tooling first, then rerun this mandatory phase."
      return $false
    }
    try {
      & $InstallCertsPs1 -RotateCa -ServerFilesOnly | Out-Host
      return $true
    } catch {
      Write-Info $_.Exception.Message
      return $false
    }
  }

  # ── EVE client (optional; not needed on a server-only host) ────────────────
  $phases += New-Phase -Id "client" -Title "EVE client setup and certificate trust" -Modes @("native", "docker") -Optional -Check {
    Sync-CertificateFolder
    $clientPath = Get-ClientPath
    if (-not $clientPath) {
      if (-not (Test-Path $LauncherConfig)) {
        return @{ Ok = $false; Detail = "no EVE client has been configured on this machine" }
      }
      return @{ Ok = $false; Detail = "the configured client folder does not exist" }
    }
    if (-not (Test-CaTrustedInRootStore)) {
      return @{ Ok = $false; Detail = "the local CA is not trusted by Windows yet" }
    }
    if (-not (Test-CaInClientBundles -ClientPath $clientPath)) {
      return @{ Ok = $false; Detail = "the local CA is not in the client's certificate bundle yet" }
    }
    return @{ Ok = $true; Detail = $clientPath }
  } -Fix {
    if (-not (Test-Path $ClientSetupBat)) {
      Write-Info "tools\ClientSETUP\StartClientSetup.bat is missing from this copy."
      return $false
    }
    if ($NonInteractive) {
      Write-Info "The client wizard needs a person at the keyboard. Skipped."
      return $true
    }
    Write-Host ""
    Write-Host "  The client setup wizard will open in a new window." -ForegroundColor Yellow
    Write-Host "  Work through its steps, then close it to come back here." -ForegroundColor Yellow
    Write-Host "  Certificates already exist, so its certificate step will succeed." -ForegroundColor Yellow
    Write-Host ""
    $exit = Invoke-Tool -FilePath $ClientSetupBat -WorkingDirectory $RepoRoot
    return ($exit -eq 0)
  }

  $phases += New-Phase -Id "client-offline" -Title "Mandatory offline client gates" -Modes @("native", "docker") -Check {
    return Get-OfflineClientStatus
  } -Fix {
    $clientPath = Get-ClientPath
    if (-not $clientPath) { return $false }
    # Validate start.ini before patching binaries or changing any trust.
    $identity = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FirewallPs1, "-ClientPath", $clientPath, "-Mode", "Plan")
    if ($identity.ExitCode -ne 0) { Write-Info $identity.Output; return $false }
    $resources = Invoke-Tool -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $ClientSetupScripts "Test-EvEJSResources.ps1"), "-ClientPath", $clientPath)
    if ($resources -ne 0) { return $false }
    $patchTool = Join-Path $ClientSetupScripts "Set-EvEJSClientNetworkPatches.ps1"
    $clientExe = Get-LauncherConfigValue -Name "EVEJS_CLIENT_EXE"
    if (-not $clientExe) { $clientExe = Join-Path $clientPath "bin64\exefile.exe" }
    $patched = Invoke-Tool -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $patchTool, "-Mode", "Apply", "-ClientPath", $clientPath, "-ClientExe", $clientExe)
    if ($patched -ne 0) { return $false }
    $certs = Invoke-Tool -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $InstallCertsPs1, "-RotateCa", "-ClientPath", $clientPath)
    return ($certs -eq 0)
  }

  # ── Client firewall (recommended; never required) ──────────────────────────
  # The two Windows Firewall blocks for the client are offered, not demanded:
  # Setup finishes without them and Play warns and starts. The check passes no
  # launcher gate value, so it is the helper's strict test and missing blocks
  # read as not installed. Declining, a cancelled administrator prompt and a
  # Windows Firewall that is off all end as [skip], never as a failed Setup.
  # Only a client that fails the identity check stops Setup here.
  $phases += New-Phase -Id "firewall" -Title "Recommended client firewall" -Modes @("native", "docker") -Optional -Check {
    $clientPath = Get-ClientPath
    if (-not $clientPath) { return @{ Ok = $false; Detail = "recommended, not installed: configure an EveJS client copy first" } }
    $probe = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FirewallPs1, "-ClientPath", $clientPath, "-Mode", "Check")
    if ($probe.ExitCode -eq 0) { return @{ Ok = $true; Detail = $probe.Output.Trim() } }
    $reason = @($probe.Output -split "\r?\n" | Where-Object { $_.Trim() }) | Select-Object -First 1
    # The helper stops at a client that fails the identity check before it reads
    # any rule, so only a firewall reason can say the blocks are not installed.
    if ("$reason" -notmatch 'Firewall \w+ gate:') { return @{ Ok = $false; Detail = "recommended, not checked: $reason" } }
    return @{ Ok = $false; Detail = "recommended, not installed: $reason" }
  } -Fix {
    $clientPath = Get-ClientPath
    if (-not $clientPath) {
      Write-Info "No EveJS client copy is configured, so there is nothing to block yet. Skipped."
      return $true
    }
    # Naming the phase in -Only is the player asking for the blocks, so do not ask again.
    if (@(Expand-IdList -Values $Only) -notcontains "firewall") {
      if ($NonInteractive) {
        Write-Info "Skipped, because this run cannot ask. Add the recommended blocks later with SetupEveJS.bat -Only firewall."
        return $true
      }
      if (-not (Read-YesNo -Question "Add the two recommended Windows Firewall blocks for the EveJS client now? Windows asks for administrator approval once." -DefaultYes $true)) {
        Write-Info "Skipped. Play warns and starts without the blocks, unless you made it strict in EvEJSConfig.bat. Add them later with SetupEveJS.bat -Only firewall."
        return $true
      }
    }
    # A client that fails the identity check is not a firewall problem. Play
    # refuses it too, so Setup stops here as it does for any other failed gate.
    $identity = Invoke-Native -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FirewallPs1, "-ClientPath", $clientPath, "-Mode", "Plan")
    if ($identity.ExitCode -ne 0) { throw "No firewall block was added. $($identity.Output.Trim())" }
    $exit = Invoke-Tool -FilePath "powershell.exe" -Arguments @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $FirewallPs1, "-ClientPath", $clientPath, "-Mode", "Install")
    if ($exit -ne 0) {
      Write-Info "The firewall blocks were not added. They are recommended, not required: Play warns and starts without them, unless you made it strict in EvEJSConfig.bat."
      Write-Info "Try again any time with SetupEveJS.bat -Only firewall."
    }
    return $true
  }

  return $phases
}

# The run order per mode. This is the actual dependency chain and the reason
# this script exists, so it is declared here rather than being implied by the
# order the phases happen to be defined in: certificates must exist before the
# client wizard can trust them, and the packages must exist before certificates
# can be generated at all.
$PhaseOrder = @{
  native = @("node", "root-deps", "certs", "server-deps", "gamedb", "market", "client", "client-offline", "firewall")
  docker = @("docker", "image", "gamedb", "market", "certs", "up", "client", "client-offline", "firewall")
}

function Expand-IdList {
  # SetupEveJS.bat forwards arguments to powershell -File, which parses them
  # literally -- so "-Only root-deps,certs" arrives as one string rather than
  # two. Split on commas so both forms work.
  param([string[]]$Values)

  if (-not $Values) {
    return @()
  }
  return @($Values |
    ForEach-Object { $_ -split "," } |
    ForEach-Object { $_.Trim() } |
    Where-Object { $_ })
}

function Get-PhasesForMode {
  param([string]$SelectedMode)

  $onlyIds = Expand-IdList -Values $Only
  $skipIds = Expand-IdList -Values $Skip
  $order = $PhaseOrder[$SelectedMode]
  $phases = @(Get-AllPhases |
    Where-Object { $_.Modes -contains $SelectedMode } |
    Sort-Object { [array]::IndexOf($order, $_.Id) })

  foreach ($phase in $phases) {
    if ([array]::IndexOf($order, $phase.Id) -lt 0) {
      throw "Phase '$($phase.Id)' is not listed in the $SelectedMode run order."
    }
  }

  if ($SkipMarket) {
    $phases = @($phases | Where-Object { $_.Id -ne "market" -or $SelectedMode -eq "docker" })
  }
  if ($SkipClient) {
    $phases = @($phases | Where-Object { $_.Id -notin @("client", "client-offline", "firewall") })
  }
  if ($onlyIds.Count -gt 0) {
    $unknown = @($onlyIds | Where-Object { $order -notcontains $_ })
    if ($unknown.Count -gt 0) {
      throw "Unknown phase id: $($unknown -join ', '). Valid ids for $SelectedMode mode: $($order -join ', ')."
    }
    $phases = @($phases | Where-Object { $onlyIds -contains $_.Id })
  }
  if ($skipIds.Count -gt 0) {
    if ($skipIds -contains "client-offline" -and -not $SkipClient) {
      throw "The offline client phase is mandatory. Use -SkipClient only for a server-only host."
    }
    $phases = @($phases | Where-Object { $skipIds -notcontains $_.Id })
  }
  return $phases
}

# ═══════════════════════════════════════════════════════════════════════════════
# RUNNER
# ═══════════════════════════════════════════════════════════════════════════════
function Invoke-Phase {
  param([pscustomobject]$Phase)

  $result = & $Phase.Check
  if ($result.Ok) {
    Write-PhaseResult -Label "[ok]" -Title $Phase.Title -Detail $result.Detail -Color Green
    return "ok"
  }

  if ($Status) {
    Write-PhaseResult -Label "[todo]" -Title $Phase.Title -Detail $result.Detail -Color Yellow
    return "todo"
  }

  Write-PhaseResult -Label "[work]" -Title $Phase.Title -Detail $result.Detail -Color Yellow

  $fixed = & $Phase.Fix
  if (-not $fixed) {
    Write-PhaseResult -Label "[FAIL]" -Title $Phase.Title -Detail "could not complete this step" -Color Red
    return "fail"
  }

  $verify = & $Phase.Check
  if ($verify.Ok) {
    Write-PhaseResult -Label "[done]" -Title $Phase.Title -Detail $verify.Detail -Color Green
    return "done"
  }

  if ($Phase.Optional) {
    Write-PhaseResult -Label "[skip]" -Title $Phase.Title -Detail $verify.Detail -Color DarkYellow
    return "skip"
  }

  Write-PhaseResult -Label "[FAIL]" -Title $Phase.Title -Detail $verify.Detail -Color Red
  return "fail"
}

function Resolve-Mode {
  if ($Mode -ne "auto") {
    return $Mode
  }

  $dockerReady = (Get-DockerPath) -and (Test-DockerLinuxEngine)
  $nodeReady = [bool](Get-CommandPath -Names @("node.exe", "node"))

  if ($NonInteractive) {
    if ($dockerReady) {
      return "docker"
    }
    return "native"
  }

  $options = @(
    "Docker  -  recommended; the backend runs in containers",
    "Native  -  run the server directly on Windows with Node.js"
  )
  $defaultIndex = 0
  if (-not $dockerReady -and $nodeReady) {
    $defaultIndex = 1
  }

  Write-Host "  Docker available : " -NoNewline
  if ($dockerReady) {
    Write-Host "yes" -ForegroundColor Green
  } else {
    Write-Host "no" -ForegroundColor DarkGray
  }
  Write-Host "  Node.js available: " -NoNewline
  if ($nodeReady) {
    Write-Host "yes" -ForegroundColor Green
  } else {
    Write-Host "no" -ForegroundColor DarkGray
  }

  $choice = Read-Choice -Question "How do you want to run the EvEJS backend?" -Options $options -DefaultIndex $defaultIndex
  if ($choice -eq 0) {
    return "docker"
  }
  return "native"
}

function Write-NextSteps {
  param([string]$SelectedMode, [bool]$ClientReady)

  Write-Host ""
  Write-Host "  What to do next" -ForegroundColor Cyan
  Write-Host "  ---------------" -ForegroundColor DarkCyan

  if ($SelectedMode -eq "docker") {
    Write-Info "The backend is running in Docker and restarts with Docker Desktop."
    Write-Info "Stop it with:  docker compose down"
  } else {
    Write-Info "Start the market (optional):  StartMarketServer.bat"
    Write-Info "Start the server:             StartServer.bat"
  }

  if ($ClientReady) {
    Write-Info "Launch the game:              Play.bat"
  } else {
    Write-Info "No EVE client is set up on this machine, so the server runs on its own."
    Write-Info "To play from here later, run SetupEveJS.bat again and do the client step."
  }
  Write-Host ""
  Write-Info "Re-run SetupEveJS.bat any time. It only redoes what is missing."
  Write-Info "See what is done without changing anything:  SetupEveJS.bat -Status"
  Write-Host ""
}

function Main {
  Write-Banner "EvEJS Setup"
  Write-Info "Project: $RepoRoot"
  Write-Host ""

  $selectedMode = Resolve-Mode
  Write-Host ""
  Write-Info "Mode: $selectedMode"
  if ($Status) {
    Write-Info "Status only -- nothing will be changed."
  }
  Write-Host ""

  $phases = Get-PhasesForMode -SelectedMode $selectedMode
  if ($phases.Count -eq 0) {
    Write-Info "No phases matched the requested filters."
    return 0
  }

  $failed = $false
  foreach ($phase in $phases) {
    $outcome = Invoke-Phase -Phase $phase
    if ($outcome -eq "fail") {
      if (-not $phase.Optional) {
        $failed = $true
        break
      }
    }
  }

  Write-Host ""
  if ($failed) {
    Write-Host "  ============================================================" -ForegroundColor Red
    Write-Host "    Setup stopped. Fix the step above, then run this again." -ForegroundColor Red
    Write-Host "  ============================================================" -ForegroundColor Red
    Write-Host ""
    return 1
  }

  if ($Status) {
    Write-Host "  Status check complete." -ForegroundColor Cyan
    Write-Host ""
    return 0
  }

  Write-Host "  ============================================================" -ForegroundColor Green
  Write-Host "    Setup complete." -ForegroundColor Green
  Write-Host "  ============================================================" -ForegroundColor Green

  $clientPhase = @(Get-AllPhases | Where-Object { $_.Id -eq "client" })[0]
  $clientReady = $false
  if (-not $SkipClient) {
    $clientReady = (& $clientPhase.Check).Ok
  }
  Write-NextSteps -SelectedMode $selectedMode -ClientReady $clientReady
  return 0
}

try {
  exit (Main)
} catch {
  # Anything that escapes a phase lands here. Print it as a sentence rather than
  # a wall of red PowerShell exception formatting.
  Write-Host ""
  Write-Host "  ============================================================" -ForegroundColor Red
  Write-Host "    Setup could not continue." -ForegroundColor Red
  Write-Host "  ============================================================" -ForegroundColor Red
  Write-Host ""
  Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
  exit 1
}
