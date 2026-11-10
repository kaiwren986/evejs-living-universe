[CmdletBinding()]
param(
    [string]$RepoRoot,
    [ValidateSet("Json", "Batch")]
    [string]$Format = "Json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
    $RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..\.."))
}

function Get-NestedValue {
    param([object]$InputObject, [string[]]$Path)

    $current = $InputObject
    foreach ($part in $Path) {
        if ($null -eq $current) { return $null }
        $property = $current.PSObject.Properties[$part]
        if ($null -eq $property) { return $null }
        $current = $property.Value
    }
    return $current
}

function Read-DotEnv {
    param([string]$Path)

    $values = @{}
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $values }

    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -notmatch '^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
            continue
        }
        $name = $Matches[1]
        $value = $Matches[2]
        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
            ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $values[$name] = $value
    }
    return $values
}

function Get-LegacyValue {
    param([string]$Text, [string]$Name, [ValidateSet("Number", "String")]$Type)

    if ($Type -eq "Number") {
        $pattern = '(?m)^\s*"' + [regex]::Escape($Name) + '"\s*:\s*(?<value>-?\d+)'
        $match = [regex]::Match($Text, $pattern)
        if ($match.Success) { return $match.Groups['value'].Value }
        return $null
    }

    $pattern = '(?m)^\s*"' + [regex]::Escape($Name) + '"\s*:\s*"(?<value>(?:\\.|[^"\\])*)"'
    $match = [regex]::Match($Text, $pattern)
    if (-not $match.Success) { return $null }
    return ('"' + $match.Groups['value'].Value + '"' | ConvertFrom-Json)
}

function Convert-ToPort {
    param([object]$Value, [string]$Name)

    $port = 0
    if (-not [int]::TryParse([string]$Value, [ref]$port) -or $port -lt 1 -or $port -gt 65535) {
        throw "$Name must be an integer from 1 through 65535; received '$Value'."
    }
    return $port
}

function Convert-ToGatewayUrl {
    param([object]$Value)

    $text = [string]$Value
    $uri = $null
    if (-not [Uri]::TryCreate($text, [UriKind]::Absolute, [ref]$uri) -or
        ($uri.Scheme -ne "http" -and $uri.Scheme -ne "https") -or
        -not $uri.Host -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw "microservicesPublicUrl must be an absolute HTTP(S) URL without credentials, query, or fragment; received '$text'."
    }
    if (-not $text.EndsWith('/')) { $text += '/' }
    return $text
}

$gamePort = 26000
$gatewayPort = 26002
$gatewayUrl = $null
$serverConfigPath = Join-Path $RepoRoot "config\server.json"

if (Test-Path -LiteralPath $serverConfigPath -PathType Leaf) {
    try {
        $serverConfig = Get-Content -LiteralPath $serverConfigPath -Raw | ConvertFrom-Json
    } catch {
        throw "Cannot read ${serverConfigPath}: $($_.Exception.Message)"
    }

    $configuredGamePort = Get-NestedValue $serverConfig @("network", "serverPort")
    $configuredGatewayPort = Get-NestedValue $serverConfig @("gateway", "microservicesPort")
    $configuredGatewayUrl = Get-NestedValue $serverConfig @("gateway", "microservicesPublicUrl")
    if ($null -ne $configuredGamePort) { $gamePort = $configuredGamePort }
    if ($null -ne $configuredGatewayPort) { $gatewayPort = $configuredGatewayPort }
    if ($null -ne $configuredGatewayUrl -and [string]$configuredGatewayUrl) {
        $gatewayUrl = $configuredGatewayUrl
    }
} else {
    # Migration/setup compatibility only. Once config/server.json exists, the
    # monolithic files are ignored so stale copies cannot override new config.
    foreach ($legacyName in @("evejs.config.json", "evejs.config.local.json")) {
        $legacyPath = Join-Path $RepoRoot $legacyName
        if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) { continue }
        $legacyText = Get-Content -LiteralPath $legacyPath -Raw
        $value = Get-LegacyValue $legacyText "serverPort" "Number"
        if ($null -ne $value) { $gamePort = $value }
        $value = Get-LegacyValue $legacyText "microservicesPublicBaseUrl" "String"
        if ($null -eq $value) {
            $value = Get-LegacyValue $legacyText "microservicesRedirectUrl" "String"
        }
        if ($null -ne $value -and [string]$value) { $gatewayUrl = $value }
    }
}

# Compose reads .env, while native users can use process environment overrides.
# Match that precedence so Play.bat probes and launches against the real target.
$dotEnv = Read-DotEnv (Join-Path $RepoRoot ".env")
$dotGatewayUrl = $null
foreach ($name in @(
    "EVEJS_MICROSERVICES_PUBLIC_URL",
    "EVEJS_MICROSERVICES_PUBLIC_BASE_URL",
    "EVEJS_MICROSERVICES_REDIRECT_URL"
)) {
    if ($dotEnv.ContainsKey($name) -and $dotEnv[$name]) {
        $dotGatewayUrl = $dotEnv[$name]
        break
    }
}
if ($dotEnv.ContainsKey("EVEJS_SERVER_PORT") -and $dotEnv["EVEJS_SERVER_PORT"]) {
    $gamePort = $dotEnv["EVEJS_SERVER_PORT"]
}
if ($dotEnv.ContainsKey("EVEJS_MICROSERVICES_PORT") -and $dotEnv["EVEJS_MICROSERVICES_PORT"]) {
    $gatewayPort = $dotEnv["EVEJS_MICROSERVICES_PORT"]
    if (-not $dotGatewayUrl) { $gatewayUrl = $null }
}
if ($dotGatewayUrl) { $gatewayUrl = $dotGatewayUrl }

$processGamePort = [Environment]::GetEnvironmentVariable("EVEJS_SERVER_PORT", "Process")
$processGatewayPort = [Environment]::GetEnvironmentVariable("EVEJS_MICROSERVICES_PORT", "Process")
$processGatewayUrl = [Environment]::GetEnvironmentVariable("EVEJS_MICROSERVICES_PUBLIC_URL", "Process")
if (-not $processGatewayUrl) {
    $processGatewayUrl = [Environment]::GetEnvironmentVariable("EVEJS_MICROSERVICES_PUBLIC_BASE_URL", "Process")
}
if (-not $processGatewayUrl) {
    $processGatewayUrl = [Environment]::GetEnvironmentVariable("EVEJS_MICROSERVICES_REDIRECT_URL", "Process")
}
if ($processGamePort) { $gamePort = $processGamePort }
if ($processGatewayPort) {
    $gatewayPort = $processGatewayPort
    if (-not $processGatewayUrl) { $gatewayUrl = $null }
}
if ($processGatewayUrl) { $gatewayUrl = $processGatewayUrl }

$gamePort = Convert-ToPort $gamePort "serverPort"
$gatewayPort = Convert-ToPort $gatewayPort "microservicesPort"
if (-not $gatewayUrl) { $gatewayUrl = "http://127.0.0.1:$gatewayPort/" }
$gatewayUrl = Convert-ToGatewayUrl $gatewayUrl

if ($Format -eq "Batch") {
    Write-Output "EVEJS_GAME_SERVER_PORT=$gamePort"
    Write-Output "EVEJS_PROXY_URL=$gatewayUrl"
    exit 0
}

[pscustomobject]@{
    gameServerPort = $gamePort
    gatewayUrl = $gatewayUrl
} | ConvertTo-Json
