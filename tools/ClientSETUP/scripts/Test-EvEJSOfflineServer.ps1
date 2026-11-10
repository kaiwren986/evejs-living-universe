[CmdletBinding()]
param([string]$ProxyUrl, [string]$RepoRoot)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-EvEJSLocalJson {
    param([string]$Url)
    $uri = [Uri]$Url
    if ($uri.Host -ne '127.0.0.1' -or $uri.Scheme -notin @('http', 'https') -or $uri.UserInfo) {
        throw 'Offline server gate: only numeric loopback HTTP(S) probes are permitted.'
    }
    $request = [Net.HttpWebRequest]::Create($uri)
    $request.Proxy = $null
    $request.AllowAutoRedirect = $false
    $request.Timeout = 4000
    $request.ReadWriteTimeout = 4000
    $request.Accept = 'application/json'
    $response = $request.GetResponse()
    try {
        if ([int]$response.StatusCode -ne 200) { throw "Offline server gate: $Url did not return HTTP 200." }
        $reader = [IO.StreamReader]::new($response.GetResponseStream())
        try { return ($reader.ReadToEnd() | ConvertFrom-Json) }
        finally { $reader.Dispose() }
    } finally { $response.Dispose() }
}

function Get-EvEJSExactJsonProperty {
    param($Value, [string]$Name)
    if ($Value -isnot [pscustomobject]) { return $null }
    # Health protocol member names are case-sensitive.
    # PowerShell's indexed PSObject.Properties lookup does not.
    foreach ($property in $Value.PSObject.Properties) {
        if ([string]::Equals($property.Name, $Name, [StringComparison]::Ordinal)) { return $property }
    }
    return $null
}

function Assert-EvEJSOfflineServer {
    param([string]$Url, [string]$Root)
    $base = [Uri]$Url
    if ($base.Scheme -ne 'http' -or $base.Host -ne '127.0.0.1' -or $base.UserInfo -or
        $base.AbsolutePath -ne '/' -or $base.Query -or $base.Fragment) {
        throw 'Proxy endpoint gate: configure http://127.0.0.1:<proxy port>/ as the local proxy URL.'
    }
    # Both listeners must advertise the same narrow local feature contract.
    foreach ($probe in @([Uri]::new($base, 'health').AbsoluteUri, 'https://127.0.0.1/health')) {
        $health = Get-EvEJSLocalJson $probe
        $healthPolicy = Get-EvEJSExactJsonProperty $health 'offlinePolicy'
        if ($null -eq $healthPolicy) {
            throw 'Proxy policy gate: restart the current EveJS server; offline policy status is missing.'
        }
        $offline = $healthPolicy.Value
        foreach ($key in @('version', 'proxyForwarding', 'clientFeatureFlags', 'clientFeatureFlagValues')) {
            if ($null -eq (Get-EvEJSExactJsonProperty $offline $key)) {
                throw "Proxy policy gate: /health is missing $key. Restart the current EveJS server."
            }
        }
        if (($offline.version -isnot [int] -and $offline.version -isnot [long]) -or $offline.version -ne 4 -or
            $offline.proxyForwarding -isnot [string] -or $offline.proxyForwarding -cne 'disabled' -or
            $offline.clientFeatureFlags -isnot [string] -or $offline.clientFeatureFlags -cne 'local-supported-features') {
            throw 'Proxy policy gate: restart the current EveJS server with forwarding disabled and the supported local UI flags enabled.'
        }
        $flags = $offline.clientFeatureFlagValues
        if ($flags -isnot [pscustomobject] -or @($flags.PSObject.Properties).Count -ne 3) {
            throw 'Proxy policy gate: expected only the local achievement, character-title and Aura guidance flags.'
        }
        foreach ($flag in @('achievements_feature_enabled', 'character_titles_feature_enabled', 'eve_ag_guidance_enabled')) {
            $entry = Get-EvEJSExactJsonProperty $flags $flag
            if ($null -eq $entry -or $entry.Value -isnot [bool] -or $entry.Value -ne $true) {
                throw "Proxy policy gate: missing or invalid local flag $flag. Restart the current EveJS server."
            }
        }
    }
    Write-Host 'Offline server gate passed: forwarding disabled, supported local UI flags enabled, shared gateway TLS verified.'

}

if ($MyInvocation.InvocationName -ne '.') {
    try {
        if (-not $RepoRoot) { $RepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..')) }
        Assert-EvEJSOfflineServer -Url $ProxyUrl -Root $RepoRoot
        exit 0
    } catch {
        Write-Host "[Offline server gate] $($_.Exception.Message)"
        Write-Host 'Check the named policy gate, local HTTPS listener, and certificate setup; then restart the server and run Play again.'
        exit 1
    }
}
