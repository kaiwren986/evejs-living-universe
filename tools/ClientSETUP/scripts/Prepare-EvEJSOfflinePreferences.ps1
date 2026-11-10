[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ClientPath,
    [string]$ClientExe,
    [Parameter(Mandatory=$true)][string]$SentryDsn
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-NoReparsePath {
    param([string]$Path)
    $absolute = [IO.Path]::GetFullPath($Path)
    if ($absolute.StartsWith('\\')) { throw "Use a client and settings folder on a local drive, not a network path: $absolute" }
    $cursor = $absolute
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing a junction or symbolic link in the client/settings path: $cursor"
        }
        $parent = [IO.Directory]::GetParent($cursor)
        if (-not $parent) { break }
        $cursor = $parent.FullName
    }
}

try {
    $clientRoot = [IO.Path]::GetFullPath($ClientPath).TrimEnd('\', '/')
    $iniPath = Join-Path $clientRoot 'start.ini'
    Assert-NoReparsePath $clientRoot
    Assert-NoReparsePath $iniPath
    $expectedExe = Join-Path $clientRoot 'bin64\exefile.exe'
    if ($ClientExe -and [IO.Path]::GetFullPath($ClientExe) -ine $expectedExe) {
        throw "EVEJS_CLIENT_EXE must be $expectedExe. Do not select a live EVE executable."
    }
    Assert-NoReparsePath $expectedExe
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($iniPath)) {
        if ($line -match '^\s*(server|cryptoPack)\s*=(.*)$') {
            $name = $Matches[1].ToLowerInvariant()
            if ($values.ContainsKey($name)) { throw "Duplicate $name in $iniPath. Refusing ambiguous client settings." }
            $values[$name] = $Matches[2].Trim()
        }
    }
    if ($values['server'] -cne '127.0.0.1' -or $values['cryptopack'] -cne 'Placebo') {
        throw 'Select the EveJS client copy with server = 127.0.0.1 and cryptoPack = Placebo.'
    }
    if ($SentryDsn -match '[\r\n]' -or $SentryDsn -cnotmatch '^http://evejs@127\.0\.0\.1:[0-9]{1,5}/1$') {
        throw 'Sentry DSN must be http://evejs@127.0.0.1:<local proxy port>/1 with no query, fragment or extra lines.'
    }
    $dsn = [Uri]$SentryDsn
    if ($dsn.Scheme -ne 'http' -or $dsn.Host -ne '127.0.0.1' -or
        $dsn.UserInfo -ne 'evejs' -or $dsn.AbsolutePath -ne '/1' -or
        $dsn.Port -lt 1 -or $dsn.Port -gt 65535 -or $dsn.Query -or $dsn.Fragment) {
        throw 'Sentry DSN must be http://evejs@127.0.0.1:<local proxy port>/1.'
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is missing.' }
    # Match utillib.GetClientUniqueFolderName; never open shared CCP\EVE\settings.dat.
    $settingsKey = $clientRoot.ToLowerInvariant().Replace('\', '_').Replace('/', '_').Replace(':', '').Replace(' ', '_') + '_127.0.0.1'
    $settingsDir = Join-Path $env:LOCALAPPDATA "CCP\EVE\$settingsKey\settings"
    $prefsPath = Join-Path $settingsDir 'prefs.ini'
    Assert-NoReparsePath $settingsDir
    Assert-NoReparsePath $prefsPath
    Assert-NoReparsePath "$prefsPath.evejs-offline-backup"
    $encoding = [Text.Encoding]::GetEncoding(1252)
    $lines = @()
    if ([IO.File]::Exists($prefsPath)) { $lines = [IO.File]::ReadAllLines($prefsPath, $encoding) }
    $kept = @($lines | Where-Object { $_ -notmatch '^\s*(sentry_io_dsn|breakpadUpload)\s*=' })
    $updated = ($kept + @("sentry_io_dsn=$SentryDsn", 'breakpadUpload=0')) -join "`r`n"
    $updated += "`r`n"
    [IO.Directory]::CreateDirectory($settingsDir) | Out-Null
    if (-not [IO.File]::Exists($prefsPath) -or [IO.File]::ReadAllText($prefsPath, $encoding) -cne $updated) {
        if ([IO.File]::Exists($prefsPath) -and -not [IO.File]::Exists("$prefsPath.evejs-offline-backup")) {
            [IO.File]::Copy($prefsPath, "$prefsPath.evejs-offline-backup")
        }
        [IO.File]::WriteAllText($prefsPath, $updated, $encoding)
    }
    Write-Host 'Crash and Sentry preference gate passed for this EveJS install.'
    exit 0
} catch {
    Write-Host "[Crash and Sentry preference gate] $($_.Exception.Message)"
    exit 1
}
