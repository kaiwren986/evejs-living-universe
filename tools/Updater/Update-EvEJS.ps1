<#
.SYNOPSIS
    EvEJS updater: replace the program files, keep the data.

.DESCRIPTION
    An EvEJS release is program files only -- no game database, no certificates,
    no installed packages, no market database. Updating is therefore always the
    same idea, and this does it in place so certificates, the launcher config and
    the compiled market survive instead of being left behind in the old folder.

    The old program files are MOVED into _backup\pre-update-<version>-<stamp>\
    rather than deleted, so a bad update is recoverable and files a new release
    no longer ships are cleaned out rather than lingering.

    What is kept and what is replaced lives in update-policy.json beside this
    script, not in this code. server\tests\updaterPolicy.test.js keeps that file
    in step with .gitignore, compose.yaml and the release builder.

    Deliberately PowerShell and not Node, for the same reason SetupEveJS.bat is:
    Docker users need no Node.js, and this has to run on an installation that is
    broken or half-installed.

.EXAMPLE
    .\UpdateEveJS.bat
    .\UpdateEveJS.bat /console
    powershell -File tools\Updater\Update-EvEJS.ps1 -NoGui -InstallPath C:\EvEJS -ZipPath C:\Downloads\EveJS-v0.12.8.zip -Preview
#>
[CmdletBinding()]
param(
  # The installation to update. Detected from this script's location when it is
  # run from inside one.
  [string]$InstallPath = "",

  # The release zip to install.
  [string]$ZipPath = "",

  [ValidateSet("auto", "native", "docker")]
  [string]$Mode = "auto",

  # Report what would change and touch nothing.
  [switch]$Preview,

  # Content packs, console only. The server installs whatever is in
  # content-packs\ when it starts, so the window no longer has a tab for this and
  # nobody needs these day to day. They are kept for support work, and so the
  # ability is still here if the window ever wants it back.
  [string[]]$InstallPack = @(),
  [string]$ImportPackDir = "",
  [switch]$ListPacks,

  # Accept a corrected build carrying a version that is already installed.
  [switch]$ReplacePacks,

  # Install an older release over a newer one.
  [switch]$AllowDowngrade,

  # Run on the console with no window. Used for automation and testing.
  [switch]$NoGui,

  # Leave the console window visible behind the updater window, so a failure
  # that happens before the window appears is still readable.
  [switch]$KeepConsole,

  # Set when this script has already re-launched itself from a temporary copy.
  [switch]$Relaunched,

  # The folder this script was originally started from, passed through a
  # re-launch so folder detection still works from the temporary copy.
  [string]$OriginRoot = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 1.0

# ═══════════════════════════════════════════════════════════════════════════════
# STATE
# ═══════════════════════════════════════════════════════════════════════════════
$script:Policy = $null
$script:LogPath = ""
$script:LogBox = $null
$script:ProgressBar = $null
$script:StatusLabel = $null
$script:Sha256 = $null
# Output of the most recent Invoke-ExternalTool, so a caller can react to what a
# tool said as well as to how it exited.
$script:LastToolOutput = @()

$script:LogDir = Join-Path $env:TEMP "EvEJS-Updater"
$script:StampFormat = "yyyyMMdd-HHmmss"

# ═══════════════════════════════════════════════════════════════════════════════
# LOGGING
# ═══════════════════════════════════════════════════════════════════════════════
function Initialize-Log {
  if (-not (Test-Path $script:LogDir)) {
    [void](New-Item -ItemType Directory -Path $script:LogDir -Force)
  }
  $stamp = (Get-Date).ToString($script:StampFormat)
  $script:LogPath = Join-Path $script:LogDir "updater-$stamp.log"
  Set-Content -LiteralPath $script:LogPath -Value "EvEJS updater $stamp" -Encoding UTF8
}

function Write-Log {
  param([string]$Text = "", [string]$Level = "info")

  $line = $Text
  if ($Level -eq "error") { $line = "[ERROR] $Text" }
  elseif ($Level -eq "warn") { $line = "[!] $Text" }
  elseif ($Level -eq "step") { $line = "== $Text" }

  if ($script:LogPath) {
    Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
  }

  if ($script:LogBox) {
    $script:LogBox.AppendText($line + [Environment]::NewLine)
    [System.Windows.Forms.Application]::DoEvents()
  } else {
    if ($Level -eq "error") { Write-Host $line -ForegroundColor Red }
    elseif ($Level -eq "warn") { Write-Host $line -ForegroundColor Yellow }
    elseif ($Level -eq "step") { Write-Host $line -ForegroundColor Cyan }
    else { Write-Host $line }
  }
}

function Set-Status {
  param([string]$Text)
  if ($script:StatusLabel) {
    $script:StatusLabel.Text = $Text
    [System.Windows.Forms.Application]::DoEvents()
  }
}

function Set-Busy {
  param([bool]$Busy)
  if ($script:ProgressBar) {
    if ($Busy) {
      $script:ProgressBar.Style = "Marquee"
      $script:ProgressBar.MarqueeAnimationSpeed = 30
    } else {
      $script:ProgressBar.MarqueeAnimationSpeed = 0
      $script:ProgressBar.Style = "Continuous"
      $script:ProgressBar.Value = 0
    }
    [System.Windows.Forms.Application]::DoEvents()
  }
}

# ═══════════════════════════════════════════════════════════════════════════════
# PATHS AND POLICY
# ═══════════════════════════════════════════════════════════════════════════════
function ConvertTo-RelativeKey {
  param([string]$Path)
  return ($Path -replace "\\", "/").Trim("/").ToLowerInvariant()
}

function Get-Policy {
  if ($script:Policy) { return $script:Policy }
  $policyPath = Join-Path $PSScriptRoot "update-policy.json"
  if (-not (Test-Path $policyPath)) {
    throw "update-policy.json is missing from $PSScriptRoot. Re-download the updater."
  }
  $raw = Get-Content -LiteralPath $policyPath -Raw -Encoding UTF8 | ConvertFrom-Json

  # Pre-compute the matchers once. Bare names (no slash) match a folder of that
  # name at any depth; anything with a slash is anchored at the install root.
  $anchoredTrees = @()
  $namedTrees = @()
  foreach ($tree in $raw.keepTrees) {
    $key = ConvertTo-RelativeKey $tree
    if ($key -like "*/*") { $anchoredTrees += $key } else { $namedTrees += $key }
  }

  $globPatterns = @()
  foreach ($glob in $raw.keepGlobs) {
    $key = ConvertTo-RelativeKey $glob
    # "**/" means "at any depth"; a lone "*" never crosses a folder boundary.
    $pattern = [regex]::Escape($key)
    $pattern = $pattern -replace "\\\*\\\*/", "(?:.*/)?"
    $pattern = $pattern -replace "\\\*", "[^/]*"
    $globPatterns += ("^" + $pattern + "$")
  }

  $keepFiles = @{}
  foreach ($file in $raw.keepFiles) { $keepFiles[(ConvertTo-RelativeKey $file)] = $true }
  $keepMine = @{}
  foreach ($file in $raw.keepMine) { $keepMine[(ConvertTo-RelativeKey $file)] = $true }

  $script:Policy = [pscustomobject]@{
    Raw = $raw
    AnchoredTrees = $anchoredTrees
    NamedTrees = $namedTrees
    GlobPatterns = $globPatterns
    KeepFiles = $keepFiles
    KeepMine = $keepMine
  }
  return $script:Policy
}

function Test-KeptDirectory {
  param([string]$RelativePath)
  $policy = Get-Policy
  $key = ConvertTo-RelativeKey $RelativePath
  if ($key -eq "") { return $false }
  foreach ($tree in $policy.AnchoredTrees) {
    if ($key -eq $tree -or $key.StartsWith($tree + "/")) { return $true }
  }
  $leaf = $key.Split("/")[-1]
  foreach ($name in $policy.NamedTrees) {
    if ($leaf -eq $name) { return $true }
    if ($key -like "*/$name/*" -or $key.StartsWith("$name/")) { return $true }
  }
  return $false
}

function Test-KeptFile {
  param([string]$RelativePath)
  $policy = Get-Policy
  $key = ConvertTo-RelativeKey $RelativePath
  if ($policy.KeepFiles.ContainsKey($key)) { return $true }
  $parent = ""
  if ($key -like "*/*") { $parent = $key.Substring(0, $key.LastIndexOf("/")) }
  if ($parent -ne "" -and (Test-KeptDirectory $parent)) { return $true }
  foreach ($pattern in $policy.GlobPatterns) {
    if ($key -match $pattern) { return $true }
  }
  return $false
}

function Test-KeepMineFile {
  param([string]$RelativePath)
  return (Get-Policy).KeepMine.ContainsKey((ConvertTo-RelativeKey $RelativePath))
}

# Walks the installation for program files, pruning kept folders. Pruning is not
# an optimisation detail: without it this would enumerate the game database,
# node_modules and a Rust target tree, which is hundreds of thousands of files.
function Get-ProgramFileList {
  param([string]$Root)

  $results = New-Object System.Collections.Generic.List[string]
  if (-not (Test-Path $Root)) { return $results }

  # Enumerated through the extended-path form so a deeply nested installation
  # does not fail the walk before the update has even started.
  $rootFull = (ConvertTo-ExtendedPath (Resolve-Path -LiteralPath $Root).Path).TrimEnd("\")
  $stack = New-Object System.Collections.Stack
  $stack.Push($rootFull)

  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($file in [System.IO.Directory]::GetFiles($dir)) {
      $rel = $file.Substring($rootFull.Length + 1)
      if (-not (Test-KeptFile $rel)) { [void]$results.Add(($rel -replace "\\", "/")) }
    }
    foreach ($child in [System.IO.Directory]::GetDirectories($dir)) {
      $rel = $child.Substring($rootFull.Length + 1)
      if (-not (Test-KeptDirectory $rel)) { $stack.Push($child) }
    }
  }
  return $results
}

function Get-FileSha256 {
  param([string]$Path)
  if (-not $script:Sha256) { $script:Sha256 = [System.Security.Cryptography.SHA256]::Create() }
  $stream = [System.IO.File]::OpenRead((ConvertTo-ExtendedPath $Path))
  try {
    return [System.BitConverter]::ToString($script:Sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    $stream.Dispose()
  }
}

function Get-DirectorySizeBytes {
  param([string]$Path, [string[]]$RelativePaths)
  $total = 0
  foreach ($rel in $RelativePaths) {
    $full = ConvertTo-ExtendedPath (Join-Path $Path ($rel -replace "/", "\"))
    try {
      if ([System.IO.File]::Exists($full)) {
        $total += (New-Object System.IO.FileInfo($full)).Length
      }
    } catch { }
  }
  return $total
}

function Format-Size {
  param([long]$Bytes)
  $units = @("B", "KB", "MB", "GB")
  $value = [double]$Bytes
  $unit = 0
  while ($value -ge 1024 -and $unit -lt ($units.Count - 1)) {
    $value = $value / 1024
    $unit += 1
  }
  if ($unit -eq 0) { return "$([int]$value) $($units[$unit])" }
  return ("{0:N1} {1}" -f $value, $units[$unit])
}

# ═══════════════════════════════════════════════════════════════════════════════
# EXTERNAL TOOLS
# ═══════════════════════════════════════════════════════════════════════════════
function Get-CommandPath {
  param([string[]]$Names)
  foreach ($name in $Names) {
    $command = Get-Command -Name $name -ErrorAction SilentlyContinue
    if ($command) {
      if ($command.Path) { return $command.Path }
      return $name
    }
  }
  return $null
}

# Quote an argument for a Windows command line. A trailing backslash before the
# closing quote escapes the quote, which is how "C:\path\" silently swallows the
# next argument -- so directory arguments are passed without one.
function ConvertTo-CommandArgument {
  param([string]$Value)
  if ($Value -match '\s') {
    return '"' + ($Value -replace '\\+$', '') + '"'
  }
  return $Value
}

# Runs a console tool, streaming its output into the log while keeping the
# window responsive. Returns the exit code.
function Invoke-ExternalTool {
  param(
    [string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$WorkingDirectory = "",
    [switch]$Quiet
  )

  $quoted = @()
  foreach ($argument in $Arguments) { $quoted += (ConvertTo-CommandArgument $argument) }
  $outPath = Join-Path $script:LogDir ("tool-" + [Guid]::NewGuid().ToString("N") + ".out")
  $errPath = "$outPath.err"

  $startArgs = @{
    FilePath = $FilePath
    NoNewWindow = $true
    PassThru = $true
    RedirectStandardOutput = $outPath
    RedirectStandardError = $errPath
  }
  if ($quoted.Count -gt 0) { $startArgs.ArgumentList = $quoted }
  if ($WorkingDirectory) { $startArgs.WorkingDirectory = $WorkingDirectory }

  $process = Start-Process @startArgs
  # Touching Handle caches it. Without that, Start-Process -PassThru hands back
  # an object whose ExitCode reads as 0 no matter how the process really ended,
  # which silently turned a failed robocopy into a successful one.
  $null = $process.Handle
  while (-not $process.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 120
  }
  $process.WaitForExit()

  $lines = @()
  foreach ($path in @($outPath, $errPath)) {
    if (Test-Path -LiteralPath $path) {
      foreach ($line in (Get-Content -LiteralPath $path -ErrorAction SilentlyContinue)) {
        if ($line.Trim() -ne "") {
          $lines += $line
          if (-not $Quiet) { Write-Log ("   " + $line) }
        }
      }
    }
  }
  $script:LastToolOutput = $lines
  foreach ($path in @($outPath, $errPath)) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
  return $process.ExitCode
}

function Invoke-Robocopy {
  param([string[]]$Arguments)
  # Logged in full: when a file move goes wrong the exclusion list is the first
  # thing support needs to see.
  if ($script:LogPath) {
    Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value ("robocopy " + [string]::Join(" ", $Arguments))
  }
  $exit = Invoke-ExternalTool -FilePath "robocopy.exe" -Arguments $Arguments -Quiet
  # Robocopy reports work done in bits 0-2. Anything from 8 up is a real failure.
  if ($exit -ge 8) { throw "robocopy failed with exit code $exit" }
  return $exit
}

function Assert-SafeComposeArguments {
  param([string[]]$Arguments)
  # Never --volumes: docker compose down --volumes deletes evejs-data, and with
  # it every account, character and market order on the server.
  foreach ($argument in $Arguments) {
    if ($argument -eq "--volumes" -or $argument -eq "-v") {
      throw "Refusing to run a compose command that removes volumes."
    }
  }
}

function Invoke-Compose {
  param([string]$Root, [string[]]$Arguments)
  $docker = Get-CommandPath -Names @("docker.exe", "docker")
  if (-not $docker) { throw "Docker was not found on PATH." }
  Assert-SafeComposeArguments $Arguments
  return (Invoke-ExternalTool -FilePath $docker -Arguments (@("compose") + $Arguments) -WorkingDirectory $Root)
}

# Same call, but the output is wanted rather than logged.
function Read-Compose {
  param([string]$Root, [string[]]$Arguments)
  $docker = Get-CommandPath -Names @("docker.exe", "docker")
  if (-not $docker) { return [pscustomobject]@{ ExitCode = -1; Lines = @() } }
  Assert-SafeComposeArguments $Arguments

  $outPath = Join-Path $script:LogDir ("docker-" + [Guid]::NewGuid().ToString("N") + ".out")
  $errPath = "$outPath.err"
  try {
    $process = Start-Process -FilePath $docker -ArgumentList (@("compose") + $Arguments) `
      -WorkingDirectory $Root -NoNewWindow -PassThru `
      -RedirectStandardOutput $outPath -RedirectStandardError $errPath
    $null = $process.Handle
    while (-not $process.HasExited) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 120
    }
    $process.WaitForExit()
    $lines = @()
    if (Test-Path -LiteralPath $outPath) {
      $lines = @(Get-Content -LiteralPath $outPath -ErrorAction SilentlyContinue)
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Lines = $lines }
  } catch {
    return [pscustomobject]@{ ExitCode = -1; Lines = @() }
  } finally {
    Remove-Item -LiteralPath $outPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errPath -Force -ErrorAction SilentlyContinue
  }
}

# ═══════════════════════════════════════════════════════════════════════════════
# INSTALLATION FACTS
# ═══════════════════════════════════════════════════════════════════════════════
function Test-IsInstallRoot {
  param([string]$Path)
  if (-not $Path) { return $false }
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  foreach ($marker in (Get-Policy).Raw.installMarkers) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path ($marker -replace "/", "\")))) { return $false }
  }
  return $true
}

function Get-InstalledVersion {
  param([string]$Root)
  $versionPath = Join-Path $Root "config\version.json"
  if (Test-Path -LiteralPath $versionPath) {
    try {
      $version = Get-Content -LiteralPath $versionPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($version.evejsVersion) { return [string]$version.evejsVersion }
    } catch { }
  }
  $packagePath = Join-Path $Root "package.json"
  if (Test-Path -LiteralPath $packagePath) {
    try {
      $package = Get-Content -LiteralPath $packagePath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($package.version) { return [string]$package.version }
    } catch { }
  }
  return "unknown"
}

function ConvertTo-ComparableVersion {
  param([string]$Text)
  $clean = ($Text -replace "[^0-9.]", "")
  $parts = @($clean.Split(".") | Where-Object { $_ -ne "" })
  while ($parts.Count -lt 4) { $parts += "0" }
  try { return [version]([string]::Join(".", $parts[0..3])) } catch { return $null }
}

function Get-ServerPorts {
  param([string]$Root)
  $ports = @(26000, 26002)
  $serverConfig = Join-Path $Root "config\server.json"
  if (Test-Path -LiteralPath $serverConfig) {
    try {
      $parsed = Get-Content -LiteralPath $serverConfig -Raw -Encoding UTF8 | ConvertFrom-Json
      $found = @()
      if ($parsed.PSObject.Properties['network'] -and $parsed.network.PSObject.Properties['serverPort']) {
        $found += [int]$parsed.network.serverPort
      }
      if ($parsed.PSObject.Properties['gateway'] -and $parsed.gateway.PSObject.Properties['microservicesPort']) {
        $found += [int]$parsed.gateway.microservicesPort
      }
      if ($found.Count -gt 0) { $ports = $found }
    } catch { }
  }
  return $ports
}

function Test-PortListening {
  param([int]$Port)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(400)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Test-DockerInstall {
  param([string]$Root)
  $docker = Get-CommandPath -Names @("docker.exe", "docker")
  if (-not $docker) { return $false }
  try {
    $volumes = & $docker volume ls --format "{{.Name}}" 2>$null
    if ($LASTEXITCODE -eq 0 -and $volumes) {
      foreach ($volume in $volumes) { if ($volume.Trim() -eq "evejs-data") { return $true } }
    }
  } catch { }
  return $false
}

function Get-InstallInfo {
  param([string]$Root, [string]$RequestedMode = "auto")

  $info = [pscustomobject]@{
    Root = $Root
    Version = Get-InstalledVersion $Root
    Mode = "native"
    IsGitCheckout = (Test-Path -LiteralPath (Join-Path $Root ".git"))
    HasLocalStore = (Test-Path -LiteralPath (Join-Path $Root "_local\gameStore\manifest.json"))
    SourceTreeStore = @()
  }

  if ($RequestedMode -ne "auto") {
    $info.Mode = $RequestedMode
  } elseif ((-not $info.HasLocalStore) -and (Test-DockerInstall $Root)) {
    $info.Mode = "docker"
  } elseif ((Test-Path -LiteralPath (Join-Path $Root "compose.yaml")) -and (-not $info.HasLocalStore) -and (Test-DockerInstall $Root)) {
    $info.Mode = "docker"
  }

  # A world in the source tree instead of _local. StartServer.bat points the
  # server at _local, so updating around this would leave the world stranded and
  # the player looking at an empty universe. Only the database counts: generated
  # tables land there routinely on an installation with no _local, and they are
  # kept in place rather than treated as a problem.
  foreach ($guard in (Get-Policy).Raw.sourceTreeStoreGuards) {
    if (Test-Path -LiteralPath (Join-Path $Root ($guard -replace "/", "\"))) {
      $info.SourceTreeStore += ($guard -replace "/", "\")
    }
  }

  # Deliberately not the installed packs: reading them on Docker means starting a
  # container, and this runs every time the folder box changes.
  return $info
}

function Test-ServerRunning {
  param($Info)
  if ($Info.Mode -eq "docker") {
    $result = Read-Compose $Info.Root @("ps", "--quiet")
    if ($result.ExitCode -ne 0) { return $false }
    foreach ($id in $result.Lines) { if ($id.Trim() -ne "") { return $true } }
    return $false
  }

  foreach ($port in (Get-ServerPorts $Info.Root)) {
    if (Test-PortListening $port) { return $true }
  }
  return $false
}

# ═══════════════════════════════════════════════════════════════════════════════
# RELEASE ZIP
# ═══════════════════════════════════════════════════════════════════════════════
# The zip standard says entry names use forward slashes, but plenty of tools --
# .NET Framework's own ZipFile among them -- write backslashes instead. Reading a
# release must not depend on which tool zipped it.
function Get-EntryName {
  param($Entry)
  return ($Entry.FullName -replace "\\", "/")
}

function Read-ReleaseZip {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) { throw "That zip file does not exist:`n$Path" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $names = @()
    foreach ($entry in $archive.Entries) { $names += (Get-EntryName $entry) }

    # Some releases are zipped with a single version folder at the top and some
    # are zipped flat. Both are valid; normalise to "no prefix".
    $prefix = ""
    $tops = @($names | ForEach-Object { ($_ -split "/")[0] } | Sort-Object -Unique)
    if ($tops.Count -eq 1) {
      $onlyTop = $tops[0]
      $hasNested = @($names | Where-Object { $_.StartsWith("$onlyTop/") }).Count -gt 0
      if ($hasNested) { $prefix = "$onlyTop/" }
    }

    $relative = @()
    foreach ($name in $names) {
      if ($name.EndsWith("/")) { continue }
      if ($prefix -ne "") {
        if (-not $name.StartsWith($prefix)) { continue }
        $relative += $name.Substring($prefix.Length)
      } else {
        $relative += $name
      }
    }

    $lookup = @{}
    foreach ($rel in $relative) { $lookup[$rel.ToLowerInvariant()] = $true }
    foreach ($marker in (Get-Policy).Raw.releaseMarkers) {
      if (-not $lookup.ContainsKey($marker.ToLowerInvariant())) {
        throw "That zip is not an EvEJS release: it has no $marker."
      }
    }

    $version = "unknown"
    $wanted = $prefix + "config/version.json"
    $versionEntry = $null
    foreach ($entry in $archive.Entries) {
      if ((Get-EntryName $entry) -eq $wanted) { $versionEntry = $entry; break }
    }
    if ($versionEntry) {
      $reader = New-Object System.IO.StreamReader($versionEntry.Open())
      try {
        $parsed = $reader.ReadToEnd() | ConvertFrom-Json
        if ($parsed.evejsVersion) { $version = [string]$parsed.evejsVersion }
      } finally { $reader.Dispose() }
    }

    return [pscustomobject]@{
      Path = $Path
      Prefix = $prefix
      Version = $version
      FileCount = $relative.Count
    }
  } finally {
    $archive.Dispose()
  }
}

function Expand-Release {
  param([string]$ZipPath, [string]$Prefix, [string]$Destination)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Remove-TreeSafely $Destination
  [void](New-Item -ItemType Directory -Path $Destination -Force)

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $done = 0
    foreach ($entry in $archive.Entries) {
      $name = Get-EntryName $entry
      if ($name.EndsWith("/")) { continue }
      if ($Prefix -ne "") {
        if (-not $name.StartsWith($Prefix)) { continue }
        $name = $name.Substring($Prefix.Length)
      }
      $target = Join-Path $Destination ($name -replace "/", "\")
      $targetDir = Split-Path -Parent $target
      if (-not (Test-Path -LiteralPath $targetDir)) {
        [void](New-Item -ItemType Directory -Path $targetDir -Force)
      }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $done += 1
      if (($done % 200) -eq 0) {
        Set-Status "Unpacking the release ... $done files"
        [System.Windows.Forms.Application]::DoEvents()
      }
    }
    return $done
  } finally {
    $archive.Dispose()
  }
}

# ═══════════════════════════════════════════════════════════════════════════════
# THE PLAN
# ═══════════════════════════════════════════════════════════════════════════════

# Every release bumps the version field in package.json and package-lock.json, so
# comparing those files byte for byte would order a multi-minute npm ci -- which
# rebuilds better-sqlite3 from source -- on every single update. Only a change to
# the packages themselves actually invalidates node_modules.
function ConvertTo-StableText {
  param($Value)
  if ($null -eq $Value) { return "null" }
  if ($Value -is [System.Collections.IDictionary]) {
    $parts = @()
    foreach ($key in ($Value.Keys | Sort-Object)) {
      $parts += ([string]$key + ":" + (ConvertTo-StableText $Value[$key]))
    }
    return "{" + [string]::Join(",", $parts) + "}"
  }
  if (($Value -is [System.Collections.IEnumerable]) -and -not ($Value -is [string])) {
    $parts = @()
    foreach ($item in $Value) { $parts += (ConvertTo-StableText $item) }
    return "[" + [string]::Join(",", $parts) + "]"
  }
  return [string]$Value
}

function Get-DependencyFingerprint {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return "" }

  # Not ConvertFrom-Json: PowerShell 5.1 refuses a package-lock outright because
  # its packages map is keyed by "" for the project's own entry.
  Add-Type -AssemblyName System.Web.Extensions
  $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $serializer.MaxJsonLength = [int]::MaxValue
  $parsed = $null
  try {
    $parsed = $serializer.DeserializeObject((Get-Content -LiteralPath $Path -Raw -Encoding UTF8))
  } catch {
    $parsed = $null
  }
  # Unreadable falls back to the raw bytes, which errs towards reinstalling.
  if (-not ($parsed -is [System.Collections.IDictionary])) { return "unreadable:" + (Get-FileSha256 $Path) }

  if ($parsed.ContainsKey("packages")) {
    # package-lock.json. The root entry carries the project's own version, which
    # changes every release; the rest describes actual resolved packages.
    $packages = $parsed["packages"]
    if (($packages -is [System.Collections.IDictionary]) -and $packages.ContainsKey("")) {
      $rootEntry = $packages[""]
      if ($rootEntry -is [System.Collections.IDictionary]) { [void]$rootEntry.Remove("version") }
    }
    return (ConvertTo-StableText $packages)
  }

  $blocks = @()
  foreach ($name in @("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")) {
    if ($parsed.ContainsKey($name)) { $blocks += (ConvertTo-StableText $parsed[$name]) } else { $blocks += "null" }
  }
  return [string]::Join("|", $blocks)
}

function Test-DependencySetChanged {
  param([string]$OldPath, [string]$NewPath)
  return ((Get-DependencyFingerprint $OldPath) -ne (Get-DependencyFingerprint $NewPath))
}

# The list of files this updater last installed. With it, "no longer shipped"
# is a fact rather than a guess, so a later update removes exactly the files the
# new release dropped and touches nothing an operator added.
function Read-InstalledFilesManifest {
  param([string]$Root)
  $path = Join-Path $Root ((Get-Policy).Raw.installedFilesManifest -replace "/", "\")
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  try {
    $parsed = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $parsed.PSObject.Properties['files']) { return $null }
    $lookup = @{}
    foreach ($rel in $parsed.files) { $lookup[([string]$rel).ToLowerInvariant()] = $true }
    if ($lookup.Count -eq 0) { return $null }
    return $lookup
  } catch {
    return $null
  }
}

function Write-InstalledFilesManifest {
  param([string]$Root, [string]$Version, $RelativePaths)
  $path = Join-Path $Root ((Get-Policy).Raw.installedFilesManifest -replace "/", "\")
  $manifest = [pscustomobject]@{
    schema = "evejs.installed-files.v1"
    comment = "Written by UpdateEveJS.bat. It records what the last update installed, so the " +
              "next one removes exactly what a new release drops and leaves your own files alone."
    version = $Version
    installedAt = (Get-Date).ToString("o")
    files = @($RelativePaths)
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $path -Encoding UTF8
}

function Get-UpdatePlan {
  param([string]$Root, [string]$StagingRoot)

  $installFiles = Get-ProgramFileList $Root
  $stagedFiles = Get-ProgramFileList $StagingRoot

  $installLookup = @{}
  foreach ($rel in $installFiles) { $installLookup[$rel.ToLowerInvariant()] = $rel }
  $stagedLookup = @{}
  foreach ($rel in $stagedFiles) { $stagedLookup[$rel.ToLowerInvariant()] = $rel }

  $added = New-Object System.Collections.Generic.List[string]
  $changed = New-Object System.Collections.Generic.List[string]
  $unchanged = 0
  $removed = New-Object System.Collections.Generic.List[string]
  $keptMine = New-Object System.Collections.Generic.List[string]

  foreach ($key in $stagedLookup.Keys) {
    $rel = $stagedLookup[$key]
    if (Test-KeepMineFile $rel) {
      if ($installLookup.ContainsKey($key)) { [void]$keptMine.Add($rel); continue }
    }
    if (-not $installLookup.ContainsKey($key)) {
      [void]$added.Add($rel)
      continue
    }
    $installFile = Join-Path $Root ($installLookup[$key] -replace "/", "\")
    $stagedFile = Join-Path $StagingRoot ($rel -replace "/", "\")
    $installInfo = New-Object System.IO.FileInfo((ConvertTo-ExtendedPath $installFile))
    $stagedInfo = New-Object System.IO.FileInfo((ConvertTo-ExtendedPath $stagedFile))
    # Length first: hashing every file in a 200 MB release to find the handful
    # that changed is wasted work when a size difference already answers it.
    if ($installInfo.Length -ne $stagedInfo.Length) {
      [void]$changed.Add($rel)
    } elseif ((Get-FileSha256 $installFile) -ne (Get-FileSha256 $stagedFile)) {
      [void]$changed.Add($rel)
    } else {
      $unchanged += 1
    }
  }


  $dependencyChanged = $false
  foreach ($trigger in (Get-Policy).Raw.dependencyTriggers) {
    $relative = $trigger -replace "/", "\"
    if (Test-DependencySetChanged (Join-Path $Root $relative) (Join-Path $StagingRoot $relative)) {
      $dependencyChanged = $true
    }
  }

  # Which files move aside. Not simply "everything": installations collect
  # community tools under tools\, and sweeping somebody's killboard into _backup
  # on every update is not this tool's business. A file moves when it belongs to
  # a release -- so it is replaced, or it is a leftover the new release dropped.
  #
  #   * in the new release            -> moves, and is replaced
  #   * in the manifest of what this  -> moves; the new release stopped shipping
  #     updater installed last time      it, which is the whole point of moving
  #   * neither, but sitting in a     -> moves: a release owns that folder, so a
  #     folder the release fills         stray file there is an old release's
  #   * neither, anywhere else        -> left alone: it is the operator's
  #
  # The manifest makes this exact from the second update onwards; the folder rule
  # is the best guess available on the first, when nothing recorded what shipped.
  # The installation root is deliberately not one of these folders. A release
  # fills it, but so does the operator -- notes, a batch file of their own, the
  # pack zip they downloaded -- and sweeping those into a backup is not this
  # tool's business. A root file the release stops shipping is caught by the
  # manifest from the next update instead.
  $previousManifest = Read-InstalledFilesManifest $Root
  $releaseDirectories = @{}
  foreach ($rel in $stagedFiles) {
    $key = $rel.ToLowerInvariant()
    $slash = $key.LastIndexOf("/")
    if ($slash -lt 0) { continue }
    $releaseDirectories[$key.Substring(0, $slash)] = $true
  }

  $filesToMove = New-Object System.Collections.Generic.List[string]
  $leftAlone = New-Object System.Collections.Generic.List[string]
  foreach ($rel in $installFiles) {
    if (Test-KeepMineFile $rel) { continue }
    $key = $rel.ToLowerInvariant()
    $slash = $key.LastIndexOf("/")
    $directory = $(if ($slash -lt 0) { "" } else { $key.Substring(0, $slash) })

    $belongsToRelease = $stagedLookup.ContainsKey($key)
    if (-not $belongsToRelease) {
      if ($null -ne $previousManifest) {
        $belongsToRelease = $previousManifest.ContainsKey($key)
      } else {
        $belongsToRelease = $releaseDirectories.ContainsKey($directory)
      }
    }
    if ($belongsToRelease) { [void]$filesToMove.Add($rel) } else { [void]$leftAlone.Add($rel) }
  }

  # "Removed" means a file the new release stopped shipping, so it is the subset
  # of what moves that has no replacement coming. Files left alone are not
  # removed by definition, and listing them as such is how a summary ends up
  # claiming a community tool was both kept and deleted.
  foreach ($rel in $filesToMove) {
    if (-not $stagedLookup.ContainsKey($rel.ToLowerInvariant())) { [void]$removed.Add($rel) }
  }

  return [pscustomobject]@{
    Added = $added
    Changed = $changed
    Removed = $removed
    UnchangedCount = $unchanged
    KeptMine = $keptMine
    InstallFiles = $installFiles
    FilesToMove = $filesToMove
    LeftAlone = $leftAlone
    HadManifest = ($null -ne $previousManifest)
    DependencyChanged = $dependencyChanged
    QuarantineBytes = (Get-DirectorySizeBytes $Root $filesToMove)
  }
}

function Write-PlanSummary {
  param($Plan, $Info, $Release)

  Write-Log ""
  Write-Log "What this update would do" "step"
  Write-Log "   From version : $($Info.Version)"
  Write-Log "   To version   : $($Release.Version)"
  Write-Log "   Install type : $($Info.Mode)"
  Write-Log "   New files    : $($Plan.Added.Count)"
  Write-Log "   Changed      : $($Plan.Changed.Count)"
  Write-Log "   Unchanged    : $($Plan.UnchangedCount)"
  Write-Log "   No longer shipped, so removed : $($Plan.Removed.Count)"
  Write-Log "   Your settings files kept as they are : $($Plan.KeptMine.Count)"
  Write-Log "   Moved to the backup folder : $($Plan.FilesToMove.Count) file(s), $(Format-Size $Plan.QuarantineBytes)"
  if ($Plan.LeftAlone.Count -gt 0) {
    Write-Log "   Not part of a release, so left where they are : $($Plan.LeftAlone.Count) file(s)"
    $folders = @($Plan.LeftAlone | ForEach-Object {
      if ($_ -like "*/*") { ($_ -split "/")[0] + "/" + ($_ -split "/")[1] } else { $_ }
    } | Sort-Object -Unique | Select-Object -First 8)
    foreach ($folder in $folders) { Write-Log "     kept: $folder" }
    if (-not $Plan.HadManifest) {
      Write-Log "     (first update here, so this is judged by folder; the next one uses an exact list)"
    }
  }
  if ($Plan.DependencyChanged) {
    Write-Log "   Server packages changed, so they will be reinstalled."
  } else {
    Write-Log "   Server packages are unchanged and will be left alone."
  }
  foreach ($rel in ($Plan.Removed | Select-Object -First 20)) { Write-Log "     removed: $rel" }
  if ($Plan.Removed.Count -gt 20) { Write-Log "     ... and $($Plan.Removed.Count - 20) more" }
  Write-Log ""
}

# ═══════════════════════════════════════════════════════════════════════════════
# THE UPDATE
# ═══════════════════════════════════════════════════════════════════════════════
function New-BackupFolder {
  param([string]$Root, [string]$FromVersion)
  $stamp = (Get-Date).ToString($script:StampFormat)
  $backupRoot = Join-Path $Root ((Get-Policy).Raw.backupRoot -replace "/", "\")
  $backup = Join-Path $backupRoot "pre-update-$FromVersion-$stamp"
  [void](New-Item -ItemType Directory -Path $backup -Force)
  return $backup
}

# Windows still applies the 260-character limit to .NET Framework file calls, and
# a release nests deeply enough to get close. The \\?\ form opts out of it.
function ConvertTo-ExtendedPath {
  param([string]$Path)
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full.StartsWith("\\?\")) { return $full }
  if ($full.StartsWith("\\")) { return "\\?\UNC\" + $full.Substring(2) }
  return "\\?\" + $full
}

# Remove-Item cannot delete a tree whose paths run past 260 characters, and the
# backup folder adds about 40 characters to every path it holds -- so the delete
# has to go through the same extended-path form the move does.
function Remove-TreeSafely {
  param([string]$Path)
  if (-not $Path) { return }
  if (-not (Test-Path -LiteralPath $Path)) { return }
  try {
    [System.IO.Directory]::Delete((ConvertTo-ExtendedPath $Path), $true)
  } catch {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Moves an exact list of relative paths, keeping their layout. The list is the
# same one the preview reports, so what is moved can never drift from what was
# described -- which is why this does not use robocopy's own exclusion rules.
function Move-FilesPreservingLayout {
  param([string]$SourceRoot, [string]$DestinationRoot, $RelativePaths)

  $moved = 0
  $failed = @()
  foreach ($rel in $RelativePaths) {
    $relative = $rel -replace "/", "\"
    $from = ConvertTo-ExtendedPath (Join-Path $SourceRoot $relative)
    $to = ConvertTo-ExtendedPath (Join-Path $DestinationRoot $relative)
    if (-not [System.IO.File]::Exists($from)) { continue }
    $toDir = [System.IO.Path]::GetDirectoryName($to)
    if (-not [System.IO.Directory]::Exists($toDir)) { [void][System.IO.Directory]::CreateDirectory($toDir) }

    # Antivirus and indexers hold files open briefly; a short retry clears it.
    $attempt = 0
    while ($true) {
      try {
        if ([System.IO.File]::Exists($to)) { [System.IO.File]::Delete($to) }
        [System.IO.File]::Move($from, $to)
        $moved += 1
        break
      } catch {
        $attempt += 1
        if ($attempt -ge 3) { $failed += $rel; break }
        Start-Sleep -Milliseconds 250
        [System.Windows.Forms.Application]::DoEvents()
      }
    }
    if (($moved % 250) -eq 0) {
      Set-Status "Moving files ... $moved"
      [System.Windows.Forms.Application]::DoEvents()
    }
  }
  return [pscustomobject]@{ Moved = $moved; Failed = $failed }
}

# Directories left behind by the move. Kept trees are never descended into, so a
# folder holding preserved data can never be removed by this.
function Remove-EmptyDirectories {
  param([string]$Root)

  $rootFull = (ConvertTo-ExtendedPath (Resolve-Path -LiteralPath $Root).Path).TrimEnd("\")
  $ordered = New-Object System.Collections.Generic.List[string]
  $stack = New-Object System.Collections.Stack
  $stack.Push($rootFull)
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($child in [System.IO.Directory]::GetDirectories($dir)) {
      $rel = $child.Substring($rootFull.Length + 1)
      if (Test-KeptDirectory $rel) { continue }
      [void]$ordered.Add($child)
      $stack.Push($child)
    }
  }
  # Deepest first, so a parent emptied by its children is removed too.
  foreach ($dir in ($ordered | Sort-Object -Property Length -Descending)) {
    try {
      if (([System.IO.Directory]::GetFileSystemEntries($dir)).Count -eq 0) {
        [System.IO.Directory]::Delete($dir)
      }
    } catch { }
  }
}

function Move-ProgramFilesToBackup {
  param([string]$Root, [string]$Backup, $RelativePaths)

  $result = Move-FilesPreservingLayout -SourceRoot $Root -DestinationRoot $Backup -RelativePaths $RelativePaths
  if ($result.Failed.Count -gt 0) {
    throw ("Could not move " + $result.Failed.Count + " file(s) out of the way. The first is " +
      $result.Failed[0] + ". Something still has them open -- close the server and any editor, then try again.")
  }
  Remove-EmptyDirectories -Root $Root
  return $result.Moved
}

function Restore-Backup {
  param([string]$Root, [string]$Backup, $RelativePaths)
  Write-Log "Putting the old files back ..." "warn"
  $result = Move-FilesPreservingLayout -SourceRoot $Backup -DestinationRoot $Root -RelativePaths $RelativePaths
  Write-Log ("   Restored " + $result.Moved + " file(s).")
  if ($result.Failed.Count -gt 0) {
    Write-Log ("   " + $result.Failed.Count + " file(s) could not be restored. They are still in $Backup") "error"
  }
}

function Copy-ReleaseIntoInstall {
  param([string]$StagingRoot, [string]$Root)
  $arguments = @($StagingRoot.TrimEnd("\"), $Root.TrimEnd("\"), "/E", "/R:3", "/W:2", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
  [void](Invoke-Robocopy $arguments)
}

function Remove-KeepMineFromStaging {
  param([string]$Root, [string]$StagingRoot)
  $kept = @()
  foreach ($file in (Get-Policy).Raw.keepMine) {
    $relative = $file -replace "/", "\"
    $installFile = Join-Path $Root $relative
    $stagedFile = Join-Path $StagingRoot $relative
    if ((Test-Path -LiteralPath $installFile) -and (Test-Path -LiteralPath $stagedFile)) {
      Remove-Item -LiteralPath $stagedFile -Force
      $kept += $file
    }
  }
  return $kept
}

function Invoke-Update {
  param(
    [string]$Root,
    [string]$ZipPath,
    [string]$RequestedMode = "auto",
    [switch]$PreviewOnly,
    [switch]$AllowDowngradeSwitch,
    [switch]$SkipPostSteps
  )

  Set-Busy $true
  try {
    Write-Log "Checking the installation ..." "step"
    if (-not (Test-IsInstallRoot $Root)) {
      throw "That folder is not an EvEJS installation:`n$Root`n`nPick the folder that has StartServer.bat in it."
    }
    $info = Get-InstallInfo -Root $Root -RequestedMode $RequestedMode
    if ($info.IsGitCheckout) {
      throw "$Root is a Git checkout. Update it with Git instead; this tool would move tracked files out from under it."
    }
    if ($info.SourceTreeStore.Count -gt 0) {
      throw ("This installation keeps its game database in the source tree rather than in _local:`n  " +
        ($info.SourceTreeStore -join "`n  ") +
        "`n`nStartServer.bat reads _local\gameStore, so updating around this would leave that world" +
        "`nbehind. Move server\src\gameStore\gamestore.sqlite (and any -wal and -shm file beside it)" +
        "`ninto _local\gameStore\ first, then update. Nothing has been changed.")
    }
    Write-Log "   Folder  : $Root"
    Write-Log "   Version : $($info.Version)"
    Write-Log "   Type    : $($info.Mode) install"

    Write-Log "Checking the release zip ..." "step"
    $release = Read-ReleaseZip $ZipPath
    Write-Log "   Zip     : $ZipPath"
    Write-Log "   Version : $($release.Version)  ($($release.FileCount) files)"

    $current = ConvertTo-ComparableVersion $info.Version
    $incoming = ConvertTo-ComparableVersion $release.Version
    if ($current -and $incoming -and $incoming -lt $current -and -not $AllowDowngradeSwitch) {
      throw "That release ($($release.Version)) is older than what is installed ($($info.Version)). Tick 'Allow downgrade' if that is really what you want."
    }
    if ($current -and $incoming -and $incoming -eq $current) {
      Write-Log "That is the version already installed. Continuing will reinstall the program files." "warn"
    }

    if (Test-ServerRunning $info) {
      if ($info.Mode -eq "docker" -and -not $PreviewOnly) {
        Write-Log "Stopping the containers (the game data volumes are never removed) ..." "step"
        [void](Invoke-Compose $Root @("down"))
        if (Test-ServerRunning $info) { throw "The containers are still running. Stop them and try again." }
      } elseif (-not $PreviewOnly) {
        throw "The server is still running. Close the server window (and the market server window) and try again."
      } else {
        Write-Log "The server is running. It must be stopped before a real update." "warn"
      }
    }

    $staging = Join-Path $script:LogDir ("staging-" + (Get-Date).ToString($script:StampFormat))
    Write-Log "Unpacking the release to a temporary folder ..." "step"
    $unpacked = Expand-Release -ZipPath $ZipPath -Prefix $release.Prefix -Destination $staging
    Write-Log "   Unpacked $unpacked file(s)."

    try {
      Write-Log "Working out what changes ..." "step"
      $plan = Get-UpdatePlan -Root $Root -StagingRoot $staging
      Write-PlanSummary -Plan $plan -Info $info -Release $release

      if ($PreviewOnly) {
        Write-Log "Preview only. Nothing was changed." "step"
        return [pscustomobject]@{ Ok = $true; Preview = $true; Plan = $plan; Info = $info; Release = $release }
      }

      $drive = Get-PSDrive -Name (Split-Path -Qualifier $Root).TrimEnd(":") -ErrorAction SilentlyContinue
      if ($drive -and $drive.Free -lt ($plan.QuarantineBytes * 2)) {
        throw ("Not enough free space on $($drive.Name): -- the update needs about " +
          (Format-Size ($plan.QuarantineBytes * 2)) + " and there is " + (Format-Size $drive.Free) + " free.")
      }

      $backup = New-BackupFolder -Root $Root -FromVersion $info.Version
      Write-Log "Moving the old program files to the backup folder ..." "step"
      Write-Log "   $backup"
      try {
        $movedCount = Move-ProgramFilesToBackup -Root $Root -Backup $backup -RelativePaths $plan.FilesToMove
        Write-Log "   Moved $movedCount file(s)."
      } catch {
        # A move that stops half way leaves the installation gutted, so put back
        # whatever did move before reporting the failure.
        Write-Log $_.Exception.Message "error"
        Restore-Backup -Root $Root -Backup $backup -RelativePaths $plan.FilesToMove
        throw "The update stopped before it changed anything that matters, and the installation was put back as it was."
      }

      $keptMine = @()
      try {
        $keptMine = Remove-KeepMineFromStaging -Root $Root -StagingRoot $staging
        Write-Log "Copying the new version in ..." "step"
        Copy-ReleaseIntoInstall -StagingRoot $staging -Root $Root
      } catch {
        Write-Log "The copy failed: $($_.Exception.Message)" "error"
        Restore-Backup -Root $Root -Backup $backup -RelativePaths $plan.FilesToMove
        throw "The update failed and the installation was put back as it was. Nothing was lost."
      }

      foreach ($file in $keptMine) { Write-Log "   kept your $file" }

      # Recorded after the copy, so the next update knows exactly what a release
      # put here and can tell a dropped file from one the operator added.
      $stagedNow = Get-ProgramFileList $staging
      Write-InstalledFilesManifest -Root $Root -Version $release.Version -RelativePaths $stagedNow

      $manifest = [pscustomobject]@{
        schema = "evejs.updater-backup.v1"
        movedAt = (Get-Date).ToString("o")
        fromVersion = $info.Version
        toVersion = $release.Version
        installMode = $info.Mode
        releaseZip = $ZipPath
        movedFileCount = $plan.FilesToMove.Count
        removedByThisRelease = @($plan.Removed)
        settingsKept = @($keptMine)
      }
      $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $backup "manifest.json") -Encoding UTF8

      if (-not $SkipPostSteps) {
        Invoke-PostUpdateSteps -Info $info -Plan $plan -Root $Root
      }

      Copy-Item -LiteralPath $script:LogPath -Destination (Join-Path $backup "update.log") -Force -ErrorAction SilentlyContinue

      Write-Log ""
      Write-Log "Update finished: $($info.Version) -> $($release.Version)" "step"
      Write-Log "Your world, settings and certificates were not touched."
      Write-Log "The old program files are in $backup"

      return [pscustomobject]@{
        Ok = $true
        Preview = $false
        Plan = $plan
        Info = $info
        Release = $release
        Backup = $backup
      }
    } finally {
      Remove-TreeSafely $staging
    }
  } finally {
    Set-Busy $false
    Set-Status "Ready"
  }
}

# The retail-parity sovereignty reset runs once per installation and records a
# marker in the game database, so running it after every update is safe: a
# second run finds the marker and does nothing. The server also runs it at
# startup when the marker is missing, so a failure here is not fatal; running
# it here does it with the server stopped, before the first start.
function Invoke-SovereigntyReset {
  param($Info, [string]$Root)

  $toolRelative = (Get-Policy).Raw.sovereigntyResetTool
  if (-not $toolRelative) {
    Write-Log "update-policy.json names no sovereignty reset tool, so the reset did not run." "warn"
    return
  }

  if ($Info.Mode -eq "docker") {
    Write-Log "Running the one-time sovereignty reset (it does nothing when it already ran) ..." "step"
    $exit = Invoke-Compose $Root @("run", "--rm", "--no-deps", "maintenance", "reset-sovereignty")
    if ($exit -ne 0) {
      Write-Log "The sovereignty reset failed with exit code $exit. With the stack stopped, run it yourself in $Root`: docker compose run --rm --no-deps maintenance reset-sovereignty" "warn"
    }
    return
  }

  $tool = Join-Path $Root ($toolRelative -replace "/", "\")
  $node = Get-CommandPath -Names @("node.exe", "node")
  if (-not $node) {
    Write-Log "Node.js was not found on PATH, so the one-time sovereignty reset did not run. Run it yourself from $Root`: node $toolRelative" "warn"
    return
  }
  if (-not (Test-Path -LiteralPath $tool)) {
    Write-Log "$toolRelative is missing from this release, so the sovereignty reset did not run." "warn"
    return
  }
  Write-Log "Running the one-time sovereignty reset (it does nothing when it already ran) ..." "step"
  $exit = Invoke-ExternalTool -FilePath $node -Arguments @($tool) -WorkingDirectory $Root
  if ($exit -ne 0) {
    Write-Log "The sovereignty reset failed with exit code $exit. Run it yourself from $Root`: node $toolRelative" "warn"
  }
}

function Invoke-PostUpdateSteps {
  param($Info, $Plan, [string]$Root)

  if ($Info.Mode -eq "docker") {
    Write-Log "Rebuilding the Docker image ..." "step"
    $exit = Invoke-Compose $Root @("build")
    if ($exit -ne 0) {
      Write-Log "docker compose build failed with exit code $exit. Run it yourself in $Root once Docker is healthy." "warn"
      return
    }
    Invoke-SovereigntyReset $Info $Root
    Write-Log "Starting the containers ..." "step"
    $exit = Invoke-Compose $Root @("up", "-d")
    if ($exit -ne 0) {
      Write-Log "docker compose up failed with exit code $exit." "warn"
    } else {
      Write-Log "The stack is starting. It can take a couple of minutes to report healthy."
    }
    return
  }

  if ($Plan.DependencyChanged) {
    $npm = Get-CommandPath -Names @("npm.cmd", "npm")
    if (-not $npm) {
      Write-Log "The server packages changed but npm was not found. StartServer.bat will install them on the next start." "warn"
    } else {
      Write-Log "The server packages changed. Reinstalling them (this can take a few minutes) ..." "step"
      $exit = Invoke-ExternalTool -FilePath $npm -Arguments @("ci", "--no-audit", "--no-fund") -WorkingDirectory (Join-Path $Root "server")
      if ($exit -ne 0) {
        Write-Log "npm ci failed with exit code $exit. StartServer.bat will retry on the next start." "warn"
      } else {
        Write-Log "   Packages installed."
      }
    }
  }

  Invoke-SovereigntyReset $Info $Root

  # Content packs are not checked here any more. The server installs whatever is
  # in content-packs\ when it starts and reports what it did, so a check at this
  # point would only duplicate that -- slowly, since it builds the whole dungeon
  # authority to do it.
  Write-Log "Content packs are installed by the server on its next start." "step"
}

# ═══════════════════════════════════════════════════════════════════════════════
# CONTENT PACKS
# ═══════════════════════════════════════════════════════════════════════════════
function Invoke-ContentPackCommand {
  param($Info, [string[]]$Arguments, [string]$MountDirectory = "", [switch]$Quiet)

  if ($Info.Mode -eq "docker") {
    $composeArgs = @("run", "--rm", "--no-deps")
    if ($MountDirectory) {
      $composeArgs += "--volume"
      $composeArgs += ($MountDirectory.TrimEnd("\") + ":/packs:ro")
    }
    $composeArgs += "content-tools"
    $composeArgs += $Arguments
    $docker = Get-CommandPath -Names @("docker.exe", "docker")
    if (-not $docker) { throw "Docker was not found on PATH." }
    Assert-SafeComposeArguments $composeArgs
    return (Invoke-ExternalTool -FilePath $docker -Arguments (@("compose") + $composeArgs) `
      -WorkingDirectory $Info.Root -Quiet:$Quiet)
  }

  $node = Get-CommandPath -Names @("node.exe", "node")
  if (-not $node) { throw "Node.js was not found on PATH. Install it from https://nodejs.org and try again." }
  $cli = Join-Path $Info.Root "tools\ContentPacks\index.js"
  if (-not (Test-Path -LiteralPath $cli)) { throw "tools\ContentPacks\index.js is missing from this installation." }
  return (Invoke-ExternalTool -FilePath $node -Arguments (@($cli) + $Arguments) `
    -WorkingDirectory $Info.Root -Quiet:$Quiet)
}

# The engine refuses a second, different build of a version that is already
# installed, because rollback to a version has to mean the same bytes. That is
# the right default and the wrong answer for an operator holding a corrected
# build they cannot renumber, so it is offered as an explicit choice.
function Test-LastOutputWasVersionConflict {
  foreach ($line in $script:LastToolOutput) {
    if ($line -match "CONTENT_PACK_VERSION_CONFLICT") { return $true }
  }
  return $false
}

function Get-InstalledPacks {
  param($Info)

  $registryPath = Join-Path $Info.Root ((Get-Policy).Raw.contentPackRegistry -replace "/", "\")
  if ((Test-Path -LiteralPath $registryPath) -and $Info.Mode -ne "docker") {
    try {
      $registry = Get-Content -LiteralPath $registryPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($registry.PSObject.Properties['installed'] -and $registry.installed) {
        return @($registry.installed | ForEach-Object {
          [pscustomobject]@{ Id = $_.id; Version = $_.version; Fingerprint = ([string]$_.packSha256).Substring(0, 12) }
        })
      }
    } catch { }
    return @()
  }

  if ($Info.Mode -eq "docker") {
    # The registry lives in the evejs-data volume, so it has to be read through
    # the container rather than from the install folder.
    $result = Read-Compose $Info.Root @("run", "--rm", "--no-deps", "content-tools", "status")
    if ($result.ExitCode -ne 0) { return @() }
    $packs = @()
    foreach ($line in $result.Lines) {
      # "  evejs.ore-anomalies@1.0.0  3cb20d236a92..."
      if ($line -match "^\s{2}(\S+)@(\S+)\s+([0-9a-f]{12})") {
        $packs += [pscustomobject]@{ Id = $Matches[1]; Version = $Matches[2]; Fingerprint = $Matches[3] }
      }
    }
    return $packs
  }
  return @()
}

# Packs are read once, at startup, so nothing may change under a running server.
function Stop-ServerForPackChange {
  param($Info)
  if (-not (Test-ServerRunning $Info)) { return }
  if ($Info.Mode -eq "docker") {
    Write-Log "Stopping the server container ..." "step"
    [void](Invoke-Compose $Info.Root @("stop", "server"))
    return
  }
  throw "The server is running. Content packs are read at startup, so close the server window first."
}

function Resume-ServerAfterPackChange {
  param($Info)
  if ($Info.Mode -eq "docker") {
    Write-Log "Starting the server container ..." "step"
    [void](Invoke-Compose $Info.Root @("start", "server"))
    return
  }
  Write-Log "Start the server with StartServer.bat to use the new content." "step"
}

# Docker reads the folder through a read-only mount; native reads it in place.
function Get-PackDirectoryArgument {
  param($Info, [string]$Directory)
  if ($Info.Mode -eq "docker") { return "/packs" }
  return $Directory
}

# Installs every pack in a folder in one go -- the same thing SetupEveJS.bat does
# on a first run, for people who keep their packs in one place.
function Import-ContentPackFolder {
  param($Info, [string]$Directory)

  Stop-ServerForPackChange $Info
  Set-Busy $true
  try {
    Write-Log "Installing every pack in $Directory ..." "step"
    $arguments = @("import", "--dir", (Get-PackDirectoryArgument $Info $Directory))
    $exit = Invoke-ContentPackCommand -Info $Info -Arguments $arguments -MountDirectory $Directory

    if ($exit -ne 0 -and (Test-LastOutputWasVersionConflict)) {
      $question = "One or more packs in that folder are different builds of versions you already " +
        "have.`n`nPack versions are meant to be fixed, so the usual answer is to ask for builds " +
        "with higher version numbers.`n`nReplace the installed builds with these anyway?"
      if ($ReplacePacks -or (Confirm-Message $question)) {
        Write-Log "Replacing the installed builds ..." "step"
        $exit = Invoke-ContentPackCommand -Info $Info -Arguments ($arguments + "--replace") -MountDirectory $Directory
      }
    }

    Write-Log "Checking every installed pack loads together ..." "step"
    [void](Invoke-ContentPackCommand -Info $Info -Arguments @("doctor"))
    Resume-ServerAfterPackChange $Info
    return ($exit -eq 0)
  } finally {
    Set-Busy $false
  }
}

function Install-ContentPackFiles {
  param($Info, [string[]]$Paths)

  Stop-ServerForPackChange $Info
  Set-Busy $true
  try {
    $installed = 0
    foreach ($path in $Paths) {
      $name = Split-Path -Leaf $path
      $directory = Split-Path -Parent $path
      $packArgument = Get-PackArgument $Info $path
      Write-Log "Checking $name ..." "step"
      $exit = Invoke-ContentPackCommand -Info $Info -Arguments @("verify", "--pack", $packArgument) -MountDirectory $directory
      if ($exit -ne 0) {
        Write-Log "$name failed its check and was not installed." "error"
        continue
      }
      Write-Log "Installing $name ..." "step"
      $exit = Invoke-ContentPackCommand -Info $Info -Arguments @("install", "--pack", $packArgument) -MountDirectory $directory

      if ($exit -ne 0 -and (Test-LastOutputWasVersionConflict)) {
        $question = "$name is a different build of a version you already have.`n`n" +
          "Pack versions are meant to be fixed, so the usual answer is to ask for a build with a " +
          "higher version number.`n`nReplace the installed build with this one anyway?"
        if ($ReplacePacks -or (Confirm-Message $question)) {
          Write-Log "Replacing the installed build of $name ..." "step"
          $exit = Invoke-ContentPackCommand -Info $Info `
            -Arguments @("install", "--pack", $packArgument, "--replace") -MountDirectory $directory
        } else {
          Write-Log "$name was left alone." "warn"
          continue
        }
      }

      if ($exit -ne 0) {
        Write-Log "$name could not be installed." "error"
        continue
      }
      $installed += 1
    }

    if ($installed -gt 0) {
      Write-Log "Checking every installed pack loads together ..." "step"
      [void](Invoke-ContentPackCommand -Info $Info -Arguments @("doctor"))
    }

    Resume-ServerAfterPackChange $Info
    return $installed
  } finally {
    Set-Busy $false
  }
}

# Docker reads packs through a read-only mount at /packs; native reads the file
# where it sits.
function Get-PackArgument {
  param($Info, [string]$Path)
  if ($Info.Mode -eq "docker") { return "/packs/" + (Split-Path -Leaf $Path) }
  return $Path
}

function Remove-ContentPack {
  param($Info, [string]$Id)

  if (Test-ServerRunning $Info) {
    if ($Info.Mode -eq "docker") {
      Write-Log "Stopping the server container ..." "step"
      [void](Invoke-Compose $Info.Root @("stop", "server"))
    } else {
      throw "The server is running. Close the server window first."
    }
  }
  Write-Log "Removing $Id ..." "step"
  $exit = Invoke-ContentPackCommand -Info $Info -Arguments @("remove", "--id", $Id)
  if ($exit -eq 0) {
    Write-Log "The pack file was kept, so it can be selected again later."
  }
  if ($Info.Mode -eq "docker") {
    [void](Invoke-Compose $Info.Root @("start", "server"))
  }
  return ($exit -eq 0)
}

# ═══════════════════════════════════════════════════════════════════════════════
# WINDOW
# ═══════════════════════════════════════════════════════════════════════════════
function Hide-ConsoleWindow {
  try {
    if (-not ("EvEJSNativeConsole" -as [type])) {
      Add-Type -Namespace "" -Name "EvEJSNativeConsole" -MemberDefinition @"
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
"@
    }
    $handle = [EvEJSNativeConsole]::GetConsoleWindow()
    if ($handle -ne [IntPtr]::Zero) { [void][EvEJSNativeConsole]::ShowWindow($handle, 0) }
  } catch { }
}

function Show-Message {
  param([string]$Text, [string]$Title = "EvEJS Updater", [string]$Icon = "Information")
  [void][System.Windows.Forms.MessageBox]::Show($Text, $Title, "OK", $Icon)
}

function Confirm-Message {
  param([string]$Text, [string]$Title = "EvEJS Updater")
  # With no window there is nobody to ask, and a message box on a headless run
  # either blocks forever or gets answered by something that is not the operator.
  # Refuse, and say what the question would have been.
  if ($NoGui) {
    Write-Log "Not confirmed, because there is no window to ask in:" "warn"
    foreach ($line in ($Text -split "`n")) {
      if ($line.Trim() -ne "") { Write-Log ("   " + $line.Trim()) }
    }
    return $false
  }
  return ([System.Windows.Forms.MessageBox]::Show($Text, $Title, "YesNo", "Question") -eq "Yes")
}

function Show-UpdaterWindow {
  param([string]$InitialInstall, [string]$InitialZip)

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $state = [pscustomobject]@{ Info = $null; Release = $null; Busy = $false }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "EvEJS Updater"
  $form.ClientSize = New-Object System.Drawing.Size(790, 640)
  $form.MinimumSize = New-Object System.Drawing.Size(700, 560)
  $form.StartPosition = "CenterScreen"
  $form.Font = New-Object System.Drawing.Font("Segoe UI", 9)

  $lblFolder = New-Object System.Windows.Forms.Label
  $lblFolder.Text = "Your EvEJS folder"
  $lblFolder.Location = New-Object System.Drawing.Point(14, 12)
  $lblFolder.AutoSize = $true
  $form.Controls.Add($lblFolder)

  $txtInstall = New-Object System.Windows.Forms.TextBox
  $txtInstall.Location = New-Object System.Drawing.Point(14, 32)
  $txtInstall.Size = New-Object System.Drawing.Size(630, 23)
  $txtInstall.Anchor = "Top,Left,Right"
  $txtInstall.Text = $InitialInstall
  $form.Controls.Add($txtInstall)

  $btnBrowse = New-Object System.Windows.Forms.Button
  $btnBrowse.Text = "Browse..."
  $btnBrowse.Location = New-Object System.Drawing.Point(654, 31)
  $btnBrowse.Size = New-Object System.Drawing.Size(120, 25)
  $btnBrowse.Anchor = "Top,Right"
  $form.Controls.Add($btnBrowse)

  $lblInstallInfo = New-Object System.Windows.Forms.Label
  $lblInstallInfo.Location = New-Object System.Drawing.Point(14, 60)
  $lblInstallInfo.Size = New-Object System.Drawing.Size(760, 18)
  $lblInstallInfo.Anchor = "Top,Left,Right"
  $lblInstallInfo.ForeColor = [System.Drawing.Color]::DimGray
  $form.Controls.Add($lblInstallInfo)

  # A plain panel rather than a one-tab TabControl. It also sidesteps the
  # TabPage sizing trap: a page reports 200x100 until its tab control has a
  # handle, so anchored children added before that land off-screen.
  $tabUpdate = New-Object System.Windows.Forms.Panel
  $tabUpdate.Location = New-Object System.Drawing.Point(14, 84)
  $tabUpdate.Size = New-Object System.Drawing.Size(760, 220)
  $tabUpdate.Anchor = "Top,Left,Right"
  $tabUpdate.BorderStyle = "FixedSingle"
  $tabUpdate.BackColor = [System.Drawing.SystemColors]::Control
  $form.Controls.Add($tabUpdate)

  # ── Update tab ──────────────────────────────────────────────────────────────

  $lblZip = New-Object System.Windows.Forms.Label
  $lblZip.Text = "The release zip you downloaded"
  $lblZip.Location = New-Object System.Drawing.Point(14, 14)
  $lblZip.AutoSize = $true
  $tabUpdate.Controls.Add($lblZip)

  # Laid out to match the folder row above it, so both things the user has to
  # pick look and work the same way.
  $txtZip = New-Object System.Windows.Forms.TextBox
  $txtZip.Location = New-Object System.Drawing.Point(14, 34)
  $txtZip.Size = New-Object System.Drawing.Size(592, 23)
  $txtZip.Anchor = "Top,Left,Right"
  $txtZip.Text = $InitialZip
  $tabUpdate.Controls.Add($txtZip)

  $btnZip = New-Object System.Windows.Forms.Button
  $btnZip.Text = "Browse..."
  $btnZip.Location = New-Object System.Drawing.Point(618, 33)
  $btnZip.Size = New-Object System.Drawing.Size(120, 25)
  $btnZip.Anchor = "Top,Right"
  $tabUpdate.Controls.Add($btnZip)

  $lblZipInfo = New-Object System.Windows.Forms.Label
  $lblZipInfo.Location = New-Object System.Drawing.Point(14, 64)
  $lblZipInfo.Size = New-Object System.Drawing.Size(720, 34)
  $lblZipInfo.Anchor = "Top,Left,Right"
  $tabUpdate.Controls.Add($lblZipInfo)

  $lblMode = New-Object System.Windows.Forms.Label
  $lblMode.Text = "Install type"
  $lblMode.Location = New-Object System.Drawing.Point(14, 108)
  $lblMode.AutoSize = $true
  $tabUpdate.Controls.Add($lblMode)

  $cboMode = New-Object System.Windows.Forms.ComboBox
  $cboMode.Location = New-Object System.Drawing.Point(90, 105)
  $cboMode.Size = New-Object System.Drawing.Size(150, 23)
  $cboMode.DropDownStyle = "DropDownList"
  [void]$cboMode.Items.AddRange(@("Detect for me", "Native (Windows)", "Docker"))
  $cboMode.SelectedIndex = 0
  $tabUpdate.Controls.Add($cboMode)

  $chkDowngrade = New-Object System.Windows.Forms.CheckBox
  $chkDowngrade.Text = "Allow downgrade"
  $chkDowngrade.Location = New-Object System.Drawing.Point(266, 106)
  $chkDowngrade.AutoSize = $true
  $tabUpdate.Controls.Add($chkDowngrade)

  $btnPreview = New-Object System.Windows.Forms.Button
  $btnPreview.Text = "Preview"
  $btnPreview.Location = New-Object System.Drawing.Point(14, 146)
  $btnPreview.Size = New-Object System.Drawing.Size(150, 36)
  $tabUpdate.Controls.Add($btnPreview)

  $btnUpdate = New-Object System.Windows.Forms.Button
  $btnUpdate.Text = "Update now"
  $btnUpdate.Location = New-Object System.Drawing.Point(174, 146)
  $btnUpdate.Size = New-Object System.Drawing.Size(170, 36)
  $tabUpdate.Controls.Add($btnUpdate)

  $lblUpdateHint = New-Object System.Windows.Forms.Label
  $lblUpdateHint.Text = "Preview changes nothing. Close the server before updating."
  $lblUpdateHint.Location = New-Object System.Drawing.Point(356, 157)
  $lblUpdateHint.AutoSize = $true
  $lblUpdateHint.ForeColor = [System.Drawing.Color]::DimGray
  $tabUpdate.Controls.Add($lblUpdateHint)

  # ── Log and footer ──────────────────────────────────────────────────────────
  $lblLog = New-Object System.Windows.Forms.Label
  $lblLog.Text = "Progress"
  $lblLog.Location = New-Object System.Drawing.Point(14, 342)
  $lblLog.AutoSize = $true
  $lblLog.Anchor = "Top,Left"
  $form.Controls.Add($lblLog)

  $txtLog = New-Object System.Windows.Forms.TextBox
  $txtLog.Location = New-Object System.Drawing.Point(14, 362)
  $txtLog.Size = New-Object System.Drawing.Size(760, 200)
  $txtLog.Multiline = $true
  $txtLog.ReadOnly = $true
  $txtLog.ScrollBars = "Vertical"
  $txtLog.BackColor = [System.Drawing.Color]::White
  $txtLog.Font = New-Object System.Drawing.Font("Consolas", 9)
  $txtLog.Anchor = "Top,Left,Right,Bottom"
  $form.Controls.Add($txtLog)

  $progress = New-Object System.Windows.Forms.ProgressBar
  $progress.Location = New-Object System.Drawing.Point(14, 572)
  $progress.Size = New-Object System.Drawing.Size(450, 18)
  $progress.Anchor = "Left,Right,Bottom"
  $form.Controls.Add($progress)

  $lblStatus = New-Object System.Windows.Forms.Label
  $lblStatus.Text = "Ready"
  $lblStatus.Location = New-Object System.Drawing.Point(14, 596)
  $lblStatus.Size = New-Object System.Drawing.Size(450, 18)
  $lblStatus.Anchor = "Left,Bottom"
  $lblStatus.ForeColor = [System.Drawing.Color]::DimGray
  $form.Controls.Add($lblStatus)

  $btnSaveLog = New-Object System.Windows.Forms.Button
  $btnSaveLog.Text = "Save log..."
  $btnSaveLog.Location = New-Object System.Drawing.Point(524, 590)
  $btnSaveLog.Size = New-Object System.Drawing.Size(120, 30)
  $btnSaveLog.Anchor = "Right,Bottom"
  $form.Controls.Add($btnSaveLog)

  $btnClose = New-Object System.Windows.Forms.Button
  $btnClose.Text = "Close"
  $btnClose.Location = New-Object System.Drawing.Point(654, 590)
  $btnClose.Size = New-Object System.Drawing.Size(120, 30)
  $btnClose.Anchor = "Right,Bottom"
  $form.Controls.Add($btnClose)

  $script:LogBox = $txtLog
  $script:ProgressBar = $progress
  $script:StatusLabel = $lblStatus

  # ── Behaviour ───────────────────────────────────────────────────────────────
  $buttons = @($btnBrowse, $btnZip, $btnPreview, $btnUpdate)

  $setBusy = {
    param([bool]$busy)
    foreach ($button in $buttons) { $button.Enabled = -not $busy }
    $state.Busy = $busy
    [System.Windows.Forms.Application]::DoEvents()
  }

  $selectedMode = {
    switch ($cboMode.SelectedIndex) {
      1 { return "native" }
      2 { return "docker" }
      default { return "auto" }
    }
  }

  $refreshInstall = {
    $path = $txtInstall.Text.Trim()
    $state.Info = $null
    if (-not $path) {
      $lblInstallInfo.Text = "Pick the folder that has StartServer.bat in it."
      $lblInstallInfo.ForeColor = [System.Drawing.Color]::DimGray
      return
    }
    if (-not (Test-IsInstallRoot $path)) {
      $lblInstallInfo.Text = "That folder is not an EvEJS installation (no server\index.js and StartServer.bat)."
      $lblInstallInfo.ForeColor = [System.Drawing.Color]::Firebrick
      return
    }
    try {
      $state.Info = Get-InstallInfo -Root (Resolve-Path -LiteralPath $path).Path -RequestedMode (& $selectedMode)
    } catch {
      $lblInstallInfo.Text = $_.Exception.Message
      $lblInstallInfo.ForeColor = [System.Drawing.Color]::Firebrick
      return
    }
    # Content packs are the server's business now: it installs whatever is in
    # content-packs\ on startup, so the updater neither lists nor counts them.
    $summary = "EvEJS $($state.Info.Version)  -  $($state.Info.Mode) install"
    if ($state.Info.IsGitCheckout) { $summary += "  -  Git checkout, this tool will refuse to update it" }
    if (@($state.Info.SourceTreeStore).Count -gt 0) { $summary += "  -  game data found in the source tree" }
    $lblInstallInfo.Text = $summary
    $lblInstallInfo.ForeColor = [System.Drawing.Color]::DimGray
  }

  $refreshZip = {
    $path = $txtZip.Text.Trim()
    $state.Release = $null
    if (-not $path) { $lblZipInfo.Text = ""; return }
    try {
      $state.Release = Read-ReleaseZip $path
      $lblZipInfo.ForeColor = [System.Drawing.Color]::DimGray
      $text = "Release $($state.Release.Version), $($state.Release.FileCount) files."
      if ($state.Info) { $text = "This would take you from $($state.Info.Version) to $($state.Release.Version). " + $text }
      $lblZipInfo.Text = $text
    } catch {
      $lblZipInfo.ForeColor = [System.Drawing.Color]::Firebrick
      $lblZipInfo.Text = $_.Exception.Message
    }
  }

  $btnBrowse.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = "Pick your EvEJS folder (the one with StartServer.bat in it)"
    $dialog.ShowNewFolderButton = $false
    if ($txtInstall.Text -and (Test-Path -LiteralPath $txtInstall.Text)) {
      $dialog.SelectedPath = $txtInstall.Text
    }
    if ($dialog.ShowDialog() -eq "OK") {
      $txtInstall.Text = $dialog.SelectedPath
      & $refreshInstall
      & $refreshZip
      Write-Log "Folder: $($txtInstall.Text)"
      Write-Log "   $($lblInstallInfo.Text)"
    }
  })

  $btnZip.Add_Click({
    $dialog = New-Object System.Windows.Forms.OpenFileDialog
    $dialog.Title = "Pick the EvEJS release zip"
    $dialog.Filter = "EvEJS release zip (*.zip)|*.zip|All files (*.*)|*.*"
    if ($dialog.ShowDialog() -eq "OK") {
      $txtZip.Text = $dialog.FileName
      & $refreshZip
      Write-Log "Release zip: $($txtZip.Text)"
      Write-Log "   $($lblZipInfo.Text)"
    }
  })

  $cboMode.Add_SelectedIndexChanged({ & $refreshInstall })
  $txtInstall.Add_Leave({ & $refreshInstall; & $refreshZip })
  $txtZip.Add_Leave({ & $refreshZip })

  $runUpdate = {
    param([bool]$previewOnly)
    if (-not $txtInstall.Text.Trim()) { Show-Message "Pick your EvEJS folder first." "EvEJS Updater" "Warning"; return }
    if (-not $txtZip.Text.Trim()) { Show-Message "Pick the release zip first." "EvEJS Updater" "Warning"; return }
    if (-not $previewOnly) {
      $question = "This replaces the program files in`n$($txtInstall.Text)`n`nYour characters, settings and certificates are kept, and the old files are moved to a backup folder.`n`nCarry on?"
      if (-not (Confirm-Message $question)) { return }
    }
    & $setBusy $true
    try {
      $result = Invoke-Update -Root (Resolve-Path -LiteralPath $txtInstall.Text.Trim()).Path `
        -ZipPath $txtZip.Text.Trim() `
        -RequestedMode (& $selectedMode) `
        -PreviewOnly:$previewOnly `
        -AllowDowngradeSwitch:$chkDowngrade.Checked
      & $refreshInstall
      if (-not $previewOnly -and $result.Ok) {
        if (Confirm-Message "The update finished.`n`nDelete the backup folder now?`n`nSay No until you have started the server and checked your characters are there.") {
          Remove-TreeSafely $result.Backup
          Write-Log "Backup folder deleted."
        }
        if ($result.Info.Mode -eq "native") {
          if (Confirm-Message "Start the server now?") {
            $starter = Join-Path $result.Info.Root "StartServer.bat"
            if (Test-Path -LiteralPath $starter) {
              Start-Process -FilePath $starter -WorkingDirectory $result.Info.Root
            }
          }
        }
      }
    } catch {
      Write-Log $_.Exception.Message "error"
      Show-Message $_.Exception.Message "EvEJS Updater" "Error"
    } finally {
      & $setBusy $false
    }
  }

  $btnPreview.Add_Click({ & $runUpdate $true })
  $btnUpdate.Add_Click({ & $runUpdate $false })

  $btnSaveLog.Add_Click({
    $dialog = New-Object System.Windows.Forms.SaveFileDialog
    $dialog.Title = "Save the updater log"
    $dialog.Filter = "Log file (*.log)|*.log|All files (*.*)|*.*"
    $dialog.FileName = Split-Path -Leaf $script:LogPath
    if ($dialog.ShowDialog() -eq "OK") {
      Copy-Item -LiteralPath $script:LogPath -Destination $dialog.FileName -Force
    }
  })

  $btnClose.Add_Click({
    if ($state.Busy) {
      if (-not (Confirm-Message "Something is still running. Close anyway?")) { return }
    }
    $form.Close()
  })

  $form.Add_Shown({
    # Otherwise the detected folder opens fully selected, which reads as "about
    # to be overwritten" rather than "this is your installation".
    $txtInstall.SelectionLength = 0
    $txtInstall.SelectionStart = 0
    $form.ActiveControl = $btnZip
    Write-Log "EvEJS Updater"
    Write-Log "Log file: $($script:LogPath)"
    Write-Log ""
    & $refreshInstall
    & $refreshZip
    Write-Log "Folder: $($txtInstall.Text)"
    Write-Log "   $($lblInstallInfo.Text)"
    if ($txtZip.Text) {
      Write-Log "Release zip: $($txtZip.Text)"
      Write-Log "   $($lblZipInfo.Text)"
    } else {
      Write-Log ""
      Write-Log "Choose the release zip you downloaded, then press Preview or Update now."
      Write-Log "Content packs are on the second tab."
    }
  })

  if (-not $KeepConsole) { Hide-ConsoleWindow }
  [void]$form.ShowDialog()
}

# ═══════════════════════════════════════════════════════════════════════════════
# ENTRY
# ═══════════════════════════════════════════════════════════════════════════════
function Find-DefaultInstall {
  param([string]$Explicit, [string]$Origin)
  if ($Explicit) { return $Explicit }
  $candidates = @()
  if ($Origin) {
    $candidates += $Origin
    $candidates += (Join-Path $Origin "..")
    $candidates += (Join-Path $Origin "..\..")
  }
  $candidates += $PSScriptRoot
  $candidates += (Join-Path $PSScriptRoot "..\..")
  foreach ($candidate in $candidates) {
    try {
      $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
      if (Test-IsInstallRoot $resolved) { return $resolved }
    } catch { }
  }
  return ""
}

# This script normally lives inside the very folder it is about to rewrite, so it
# re-runs itself from a temporary copy first. Otherwise the update would move the
# running script out from under itself.
function Invoke-SelfRelaunch {
  param([string]$DetectedInstall)

  $temp = Join-Path $env:TEMP ("EvEJS-Updater-run-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
  [void](New-Item -ItemType Directory -Path $temp -Force)
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $temp "Update-EvEJS.ps1") -Force
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot "update-policy.json") -Destination (Join-Path $temp "update-policy.json") -Force

  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", ('"' + (Join-Path $temp "Update-EvEJS.ps1") + '"'),
    "-Relaunched",
    "-OriginRoot", ('"' + $DetectedInstall + '"')
  )
  if ($InstallPath) { $arguments += @("-InstallPath", ('"' + $InstallPath + '"')) }
  if ($ZipPath) { $arguments += @("-ZipPath", ('"' + $ZipPath + '"')) }
  if ($Mode -ne "auto") { $arguments += @("-Mode", $Mode) }
  if ($Preview) { $arguments += "-Preview" }
  if ($AllowDowngrade) { $arguments += "-AllowDowngrade" }
  if ($NoGui) { $arguments += "-NoGui" }
  if ($KeepConsole) { $arguments += "-KeepConsole" }

  $startArgs = @{ FilePath = "powershell.exe"; ArgumentList = $arguments; PassThru = $true; Wait = $true }
  # Console runs keep the same console so their output is still readable; the
  # window mode gets its own process, which is the point of re-launching.
  if ($NoGui) { $startArgs.NoNewWindow = $true }
  $process = Start-Process @startArgs
  exit $process.ExitCode
}

function Main {
  Initialize-Log
  [void](Get-Policy)

  $defaultInstall = Find-DefaultInstall -Explicit $InstallPath -Origin $OriginRoot

  if (-not $Relaunched) {
    $scriptHome = ""
    try { $scriptHome = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\..")).Path } catch { }
    if ($scriptHome -and (Test-IsInstallRoot $scriptHome)) {
      Invoke-SelfRelaunch -DetectedInstall $scriptHome
      return
    }
  }

  if (-not $NoGui) {
    Add-Type -AssemblyName System.Windows.Forms
    Show-UpdaterWindow -InitialInstall $defaultInstall -InitialZip $ZipPath
    return
  }

  # Console mode. Used by automation and by support.
  Add-Type -AssemblyName System.Windows.Forms
  if (-not $defaultInstall) { throw "Pass -InstallPath: no EvEJS installation was found near this script." }

  if ($ListPacks -or $InstallPack.Count -gt 0 -or $ImportPackDir) {
    if (-not (Test-IsInstallRoot $defaultInstall)) {
      throw "That folder is not an EvEJS installation:`n$defaultInstall"
    }
    $info = Get-InstallInfo -Root (Resolve-Path -LiteralPath $defaultInstall).Path -RequestedMode $Mode
    if ($InstallPack.Count -gt 0) {
      [void](Install-ContentPackFiles -Info $info -Paths $InstallPack)
    }
    if ($ImportPackDir) {
      [void](Import-ContentPackFolder -Info $info -Directory (Resolve-Path -LiteralPath $ImportPackDir).Path)
    }
    $packs = @(Get-InstalledPacks $info)
    if ($packs.Count -eq 0) {
      Write-Log "Installed content packs: none"
    } else {
      Write-Log "Installed content packs:"
      foreach ($pack in $packs) { Write-Log ("   " + $pack.Id + "@" + $pack.Version + "  " + $pack.Fingerprint) }
    }
    return
  }

  if (-not $ZipPath) { throw "Pass -ZipPath: the release zip to install." }
  $result = Invoke-Update -Root $defaultInstall -ZipPath $ZipPath -RequestedMode $Mode `
    -PreviewOnly:$Preview -AllowDowngradeSwitch:$AllowDowngrade
  if (-not $result.Ok) { exit 1 }
}

try {
  Main
} catch {
  $message = $_.Exception.Message
  if ($script:LogPath) { Write-Log $message "error" }
  if (-not $NoGui) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show($message, "EvEJS Updater", "OK", "Error")
    } catch { }
  } else {
    Write-Host $message -ForegroundColor Red
  }
  exit 1
}
