param(
  [string]$ClientPath,
  [switch]$CheckOnly,
  [switch]$RotateCa,
  [switch]$ForceRebuildGatewayCert,
  [switch]$ServerFilesOnly
)

$ErrorActionPreference = "Stop"
if ($CheckOnly -and $ServerFilesOnly) { throw "CheckOnly always checks the complete client trust gate; ServerFilesOnly cannot waive it." }
if ($ClientPath -and $ServerFilesOnly) { throw "ServerFilesOnly cannot prepare a client. Remove that switch to install and verify client trust." }

# Play.bat intentionally launches Windows PowerShell, but it can inherit a
# PSModulePath from a PowerShell Core parent. If the Core 7 module directory is
# first, command autoload tries that incompatible Microsoft.PowerShell.Security
# manifest before the built-in Desktop module and Get-PfxCertificate fails.
# Import by this host's own $PSHOME path so both Windows PowerShell and pwsh use
# the security module shipped for their exact engine instead of search order.
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

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$builderScriptPath = Join-Path $PSScriptRoot "build-gateway-cert.js"
$certificateFilesScriptPath = Join-Path $repoRoot "server\src\config\certificateFiles.js"

# The certificates live in the data root's certs folder: EVEJS_DATA_ROOT\certs, else
# <repo>\_local\certs. server\src\config\certificateFiles.js holds that rule, and these starting
# values follow it. Once Node is found, the main flow below runs that file: it copies an existing
# CA and certificates in from server\certs and server\src\_secondary\express\certs, where they
# were before 2026-09-21, and prints the folder, which the script then uses.
function Set-CertificatePaths {
  param([string]$CertDir)

  $script:certDir = $CertDir
  $script:caCertPath = Join-Path $CertDir "xmpp-ca-cert.pem"
  $script:caKeyPath = Join-Path $CertDir "xmpp-ca-key.pem"
  $script:xmppCertDir = $CertDir
  $script:xmppCertPath = Join-Path $CertDir "xmpp-dev-cert.pem"
  $script:xmppKeyPath = Join-Path $CertDir "xmpp-dev-key.pem"
  $script:gatewayCertDir = $CertDir
  $script:gatewayCertPath = Join-Path $CertDir "gateway-dev-cert.pem"
  $script:gatewayKeyPath = Join-Path $CertDir "gateway-dev-key.pem"
  $script:gatewayDnsCertPath = Join-Path $CertDir "gateway-dns-cert.pem"
  $script:gatewayDnsKeyPath = Join-Path $CertDir "gateway-dns-key.pem"
}

$dataRoot = if ($env:EVEJS_DATA_ROOT) { [System.IO.Path]::GetFullPath($env:EVEJS_DATA_ROOT) } else { Join-Path $repoRoot "_local" }
Set-CertificatePaths -CertDir (Join-Path $dataRoot "certs")
$gatewayFriendlyName = "eve.js Public Gateway TLS"
$gatewaySubject = "CN=dev-public-gateway.evetech.net"

# Must stay identical to LOCAL_TLS_DNS_ALT_NAMES in
# server\src\_secondary\express\localTlsCertificate.js. The server checks the
# gateway leaf against that exact set on every boot and silently rebuilds the
# certificate when it does not match, which would throw away the leaf this
# script just built and re-signed into the client bundles.
$gatewayDnsNames = @(
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
$gatewayIpNames = @("127.0.0.1")
$retiredCaThumbprint = "BDAC54736BCC544A2C3DC77294905447FD856FD6"

function Test-RetiredEvEJSCertificate {
  param($Certificate)
  if ($Certificate.Thumbprint -eq $retiredCaThumbprint) { return $true }
  if ($Certificate.Subject -notlike "*eve.js localhost CA*" -and $Certificate.Subject -notlike "*EvEJS Local*") { return $false }
  $constraint = @($Certificate.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.30" -and $_.Critical })
  $expected = @()
  if (Test-Path -LiteralPath $caCertPath) {
    $current = Get-PfxCertificate -FilePath $caCertPath
    $expected = @($current.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.30" -and $_.Critical })
  }
  $matchesPolicy = ($constraint.Count -eq 1 -and $expected.Count -eq 1 -and
    [Convert]::ToBase64String($constraint[0].RawData) -eq [Convert]::ToBase64String($expected[0].RawData))
  return (-not $matchesPolicy)
}

function Assert-NoRetiredRoots {
  $retired = @(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { Test-RetiredEvEJSCertificate $_ })
  if ($retired.Count -gt 0) {
    throw "CA trust gate: retired or unconstrained EveJS CA still trusted. Run Install-EvEJSCerts.ps1 -RotateCa -ClientPath `"$resolvedClientPath`"."
  }
}

function Write-Step {
  param([string]$Message)

  Write-Host "[eve.js] $Message" -ForegroundColor Cyan
}

function Get-NodeCommand {
  $nodeCommand = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeCommand) {
    $nodeCommand = (Get-Command node -ErrorAction SilentlyContinue).Source
  }
  if (-not $nodeCommand) {
    throw "Node.js was not found on PATH. Install the LTS release from https://nodejs.org and run this again."
  }

  return $nodeCommand
}

function Get-NpmCommand {
  foreach ($candidate in @("npm.cmd", "npm")) {
    $npmCommand = (Get-Command $candidate -ErrorAction SilentlyContinue).Source
    if ($npmCommand) {
      return $npmCommand
    }
  }

  return $null
}

function Test-NodeForgeAvailable {
  $nodeCommand = Get-NodeCommand
  # $ErrorActionPreference is Stop for this script, which would turn the probe's
  # stderr output into a terminating error. A failed require is the expected
  # answer here, not a crash.
  $ErrorActionPreference = "Continue"
  Push-Location $repoRoot
  try {
    & $nodeCommand -e "require('node-forge')" 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  } finally {
    Pop-Location
  }
}

function Ensure-CertificateToolingDependencies {
  # build-gateway-cert.js needs node-forge. On a fresh checkout nothing has run
  # npm yet, and the launcher that installs packages (StartServer.bat) used to
  # refuse to run until this wizard had already written EvEJSConfig.bat -- so
  # certificate generation could never happen first. Install the root packages
  # here instead of depending on that ordering. Root install is pure JavaScript;
  # it does not build the native server modules.
  if (Test-NodeForgeAvailable) {
    return
  }

  throw "Certificate tooling gate: node-forge is missing. Install the setup packages before running this script; it does not download packages."
}

function Ensure-LocalCertificateFiles {
  # The chat certificate is issued for "localhost" regardless of where the
  # server actually listens. The EVE client validates this connection against
  # its certifi CA bundle only and does not check the hostname (see
  # ensureXmppTlsCertificate in server\src\_secondary\express\localTlsCertificate.js),
  # so this stays correct for a LAN or multiplayer host. The server reuses an
  # existing certificate and only generates one when these files are absent.
  New-Item -ItemType Directory -Force -Path $xmppCertDir | Out-Null

  if (Test-LeafNeedsRebuild `
    -CertPath $xmppCertPath `
    -KeyPath $xmppKeyPath `
    -RequiredDnsNames @("localhost")) {
    Invoke-CertificateBuilder `
      -OutCertPath $xmppCertPath `
      -OutKeyPath $xmppKeyPath `
      -CommonName "localhost" `
      -DnsNames @("localhost") `
      -IpNames @("127.0.0.1")
    Write-Step "Built CA-signed XMPP TLS cert under $xmppCertDir"
  }
}

function Resolve-ConfiguredClientPath {
  param([string]$ConfiguredPath)

  $candidates = @()
  if ($ConfiguredPath) {
    $candidates += $ConfiguredPath
  }
  if ($env:EVEJS_CLIENT_PATH) {
    $candidates += $env:EVEJS_CLIENT_PATH
  }
  $configPath = Join-Path $PSScriptRoot "EvEJSConfig.bat"
  if (Test-Path -LiteralPath $configPath) {
    foreach ($line in Get-Content -LiteralPath $configPath) {
      if ($line -match '^\s*set\s+"EVEJS_CLIENT_PATH=(.*)"\s*$') {
        $candidates += $Matches[1].Replace('%EVEJS_REPO_ROOT%', $repoRoot)
      }
    }
  }
  $repoClientPath = Join-Path $repoRoot "client\EVE\tq"
  if (Test-Path $repoClientPath) {
    $candidates += $repoClientPath
  }

  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return (Resolve-Path -Path $candidate).Path
    }
  }

  return $null
}

function Get-ClientBundlePaths {
  param([string]$ResolvedClientPath)

  if (-not $ResolvedClientPath) {
    return @()
  }

  # Walk one level at a time so a package junction can never redirect a bundle
  # write into another (possibly live EVE) install or a network share.
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($ResolvedClientPath)
  $bundles = @()
  while ($pending.Count -gt 0) {
    $directory = $pending.Pop()
    foreach ($entry in Get-ChildItem -LiteralPath $directory -Force) {
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "CA bundle gate: refusing junction or symbolic link $($entry.FullName). Use a separate complete EveJS client copy."
      }
      if ($entry.PSIsContainer) { $pending.Push($entry.FullName) }
      elseif ($entry.Name -ieq "cacert.pem") { $bundles += $entry.FullName }
    }
  }
  return @($bundles | Sort-Object -Unique)
}

function Remove-PemBlockFromContent {
  param(
    [string]$Content,
    [string]$PemBlock
  )

  if (-not $PemBlock) {
    return $Content
  }

  $trimmedPem = $PemBlock.Trim()
  if (-not $trimmedPem) {
    return $Content
  }

  return ($Content -replace [regex]::Escape($trimmedPem), "").TrimEnd() + "`r`n"
}

function Convert-PemBlockToCertificate {
  param([string]$PemBlock)

  $base64 = ($PemBlock `
    -replace "-----BEGIN CERTIFICATE-----", "" `
    -replace "-----END CERTIFICATE-----", "" `
    -replace "\s", "")

  if (-not $base64) {
    return $null
  }

  try {
    $bytes = [Convert]::FromBase64String($base64)
    return New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList @(,$bytes)
  } catch {
    return $null
  }
}

function Remove-EvEJSLocalCertificateBlocksFromContent {
  param(
    [string]$Content,
    [string]$CurrentCaThumbprint
  )

  if (-not $Content) {
    return ""
  }

  $regex = New-Object System.Text.RegularExpressions.Regex(
    "-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----",
    [System.Text.RegularExpressions.RegexOptions]::Multiline
  )

  $updated = $regex.Replace(
    $Content,
    [System.Text.RegularExpressions.MatchEvaluator]{
      param($match)

      $cert = Convert-PemBlockToCertificate -PemBlock $match.Value
      if ($cert) {
        $subject = [string]$cert.Subject
        $issuer = [string]$cert.Issuer
        $thumbprint = [string]$cert.Thumbprint
        if (
          (Test-RetiredEvEJSCertificate $cert) -or
          $subject -like "*EvEJS Local*" -or
          $issuer -like "*EvEJS Local*" -or
          $subject -like "*eve.js Public Gateway TLS*" -or
          $issuer -like "*eve.js Public Gateway TLS*"
        ) {
          if ($CurrentCaThumbprint -and $thumbprint -eq $CurrentCaThumbprint) {
            return $match.Value
          }
          return ""
        }
      }

      return $match.Value
    }
  )

  return $updated.TrimEnd() + "`r`n"
}

function Ensure-PemBundleContainsCa {
  param(
    [string]$BundlePath,
    [string]$PemCaPath,
    [string[]]$PemBlocksToRemove = @()
  )

  $bundleRaw = Get-Content -LiteralPath $BundlePath -Raw
  foreach ($pemBlock in $PemBlocksToRemove) {
    $bundleRaw = Remove-PemBlockFromContent -Content $bundleRaw -PemBlock $pemBlock
  }

  $caRaw = (Get-Content -LiteralPath $PemCaPath -Raw).Trim()
  $caCert = Get-PfxCertificate -FilePath $PemCaPath
  $bundleRaw = Remove-EvEJSLocalCertificateBlocksFromContent `
    -Content $bundleRaw `
    -CurrentCaThumbprint $caCert.Thumbprint

  if ($bundleRaw.Contains($caRaw)) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($BundlePath, $bundleRaw, $encoding)
    Write-Step "CA already present in $BundlePath"
    return
  }

  $updated = $bundleRaw.TrimEnd() + "`r`n`r`n" + $caRaw + "`r`n"
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($BundlePath, $updated, $encoding)
  $verifyRaw = Get-Content -LiteralPath $BundlePath -Raw
  if (-not $verifyRaw.Contains($caRaw)) {
    throw "Failed to verify EvEJS CA inside $BundlePath after writing."
  }
  Write-Step "Appended CA to $BundlePath"
}

function Ensure-RootTrust {
  param([string]$PemPath)

  $cert = Get-PfxCertificate -FilePath $PemPath
  $staleCerts = @(Get-ChildItem Cert:\CurrentUser\Root -ErrorAction SilentlyContinue | Where-Object {
    (Test-RetiredEvEJSCertificate $_) -and $_.Thumbprint -ne $cert.Thumbprint
  })

  foreach ($staleCert in $staleCerts) {
    Remove-Item -LiteralPath (Join-Path "Cert:\CurrentUser\Root" $staleCert.Thumbprint) -ErrorAction Stop
  }
  if ($staleCerts.Count -gt 0) {
    Write-Step "Removed $($staleCerts.Count) stale EvEJS CA certificate(s) from CurrentUser\Root."
  }

  $existing = Get-ChildItem Cert:\CurrentUser\Root | Where-Object {
    $_.Thumbprint -eq $cert.Thumbprint
  }

  if ($existing) {
    Write-Step "CA already trusted in CurrentUser\Root."
    return
  }

  Import-Certificate -FilePath $PemPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  Assert-NoRetiredRoots
  Write-Step "Installed CA into CurrentUser\Root."
}

function Remove-ExistingGatewayCerts {
  $stores = @("Cert:\CurrentUser\My", "Cert:\CurrentUser\Root")
  foreach ($store in $stores) {
    $existing = Get-ChildItem $store | Where-Object {
      $_.FriendlyName -eq $gatewayFriendlyName -or $_.Subject -eq $gatewaySubject
    }

    foreach ($cert in $existing) {
      Remove-Item -Path (Join-Path $store $cert.Thumbprint) -DeleteKey -ErrorAction SilentlyContinue
    }
  }
}

function Test-LeafNeedsRebuild {
  param(
    [string]$CertPath,
    [string]$KeyPath,
    [string[]]$RequiredDnsNames,
    [switch]$DnsOnly
  )

  if ((-not (Test-Path $CertPath)) -or (-not (Test-Path $KeyPath))) {
    return $true
  }
  if ((-not (Test-Path $caCertPath)) -or (-not (Test-Path $caKeyPath))) {
    return $true
  }

  try {
    $nodeCommand = Get-NodeCommand
    $ErrorActionPreference = "Continue"
    $arguments = @($builderScriptPath, '--check-only', '--ca-cert', $caCertPath, '--ca-key', $caKeyPath, '--out-cert', $CertPath, '--out-key', $KeyPath, '--dns', ($RequiredDnsNames -join ','))
    if ($DnsOnly) { $arguments += '--dns-only' }
    else { $arguments += @('--ip', ($gatewayIpNames -join ',')) }
    & $nodeCommand @arguments 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { return $true }
    $cert = Get-PfxCertificate -FilePath $CertPath
    $caCert = Get-PfxCertificate -FilePath $caCertPath
    if ([string]::Equals($cert.Subject, $cert.Issuer, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
    if (-not [string]::Equals($cert.Issuer, $caCert.Subject, [System.StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }

    $dnsNames = @($cert.DnsNameList | ForEach-Object { $_.Unicode.ToLowerInvariant() })
    foreach ($requiredName in $RequiredDnsNames) {
      if ($dnsNames -notcontains $requiredName) {
        return $true
      }
    }

    return $false
  } catch {
    return $true
  }
}

function Invoke-CertificateBuilder {
  param(
    [string]$OutCertPath,
    [string]$OutKeyPath,
    [string]$CommonName,
    [string[]]$DnsNames,
    [string[]]$IpNames,
    [switch]$DnsOnly
  )

  $nodeCommand = Get-NodeCommand
  # Let the exit-code check below report the failure instead of the raw stderr
  # stream becoming a terminating error first.
  $ErrorActionPreference = "Continue"
  $arguments = @($builderScriptPath, '--ensure-ca', '--ca-cert', $caCertPath, '--ca-key', $caKeyPath,
    '--common-name', $CommonName, '--dns', ($DnsNames -join ','), '--out-cert', $OutCertPath, '--out-key', $OutKeyPath)
  if ($DnsOnly) { $arguments += '--dns-only' }
  else { $arguments += @('--ip', ($IpNames -join ',')) }
  & $nodeCommand @arguments

  if ($LASTEXITCODE -ne 0) {
    throw "Failed to build local TLS certificate for $CommonName."
  }
}

function Build-GatewayCertificate {
  New-Item -ItemType Directory -Force -Path $gatewayCertDir | Out-Null
  $previousLeafPems = @()
  if ($ForceRebuildGatewayCert -and -not $ServerFilesOnly) { Remove-ExistingGatewayCerts }
  foreach ($leaf in @(
    @{ Cert = $gatewayCertPath; Key = $gatewayKeyPath; DnsOnly = $false },
    @{ Cert = $gatewayDnsCertPath; Key = $gatewayDnsKeyPath; DnsOnly = $true }
  )) {
    if (Test-Path -LiteralPath $leaf.Cert) { $previousLeafPems += (Get-Content -LiteralPath $leaf.Cert -Raw).Trim() }
    if ($ForceRebuildGatewayCert) { Remove-Item -LiteralPath $leaf.Cert, $leaf.Key -Force -ErrorAction SilentlyContinue }
    if (-not (Test-LeafNeedsRebuild -CertPath $leaf.Cert -KeyPath $leaf.Key -RequiredDnsNames $gatewayDnsNames -DnsOnly:$leaf.DnsOnly)) {
      Write-Step "Gateway TLS files already current: $($leaf.Cert)"
      continue
    }
    Invoke-CertificateBuilder -OutCertPath $leaf.Cert -OutKeyPath $leaf.Key -CommonName 'dev-public-gateway.evetech.net' `
      -DnsNames $gatewayDnsNames -IpNames $gatewayIpNames -DnsOnly:$leaf.DnsOnly
    if (Test-LeafNeedsRebuild -CertPath $leaf.Cert -KeyPath $leaf.Key -RequiredDnsNames $gatewayDnsNames -DnsOnly:$leaf.DnsOnly) {
      throw "TLS certificate gate: generated gateway leaf did not pass verification: $($leaf.Cert)"
    }
    Write-Step "Built CA-signed gateway TLS certificate: $($leaf.Cert)"
  }
  return $previousLeafPems
}

function Assert-ClientBundlesCurrent {
  param([string[]]$BundlePaths)
  if ($BundlePaths.Count -eq 0) { throw "CA bundle gate: no cacert.pem found under $resolvedClientPath. Run client setup." }
  $caRaw = (Get-Content -LiteralPath $caCertPath -Raw).Trim()
  foreach ($bundlePath in $BundlePaths) {
    $raw = Get-Content -LiteralPath $bundlePath -Raw
    if (-not $raw.Contains($caRaw)) { throw "CA bundle gate: $bundlePath does not trust the current EveJS CA. Run Install-EvEJSCerts.ps1 -RotateCa." }
    foreach ($match in [regex]::Matches($raw, '-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----')) {
      $cert = Convert-PemBlockToCertificate $match.Value
      if ($cert -and (Test-RetiredEvEJSCertificate $cert)) {
        throw "CA bundle gate: retired EveJS CA remains in $bundlePath. Run Install-EvEJSCerts.ps1 -RotateCa."
      }
    }
  }
}

function Test-CertificateAuthorityCurrent {
  $ErrorActionPreference = "Continue"
  & $nodeCommand $builderScriptPath --check-only --ca-only --ca-cert $caCertPath --ca-key $caKeyPath 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

# Check the install identity before generation, trust-store writes or bundle
# edits. A server-only certificate build does not touch a client or its trust.
$resolvedClientPath = $null
if (-not $ServerFilesOnly) {
  $resolvedClientPath = Resolve-ConfiguredClientPath -ConfiguredPath $ClientPath
  if (-not $resolvedClientPath) { throw "Client identity gate: configure EVEJS_CLIENT_PATH or pass -ClientPath." }
  $firewallHelper = Join-Path $PSScriptRoot "Set-EvEJSFirewall.ps1"
  & { . $firewallHelper; Get-EvEJSClientIdentity -Path $resolvedClientPath | Out-Null }
}

Ensure-CertificateToolingDependencies
$nodeCommand = Get-NodeCommand

# Use the certs folder the server uses, and copy an existing CA and certificates into it from the
# old folders if it does not have them yet. -CheckOnly does this too: it changes nothing a player
# can see, keeps the CA the client already trusts, and the server does the same when it starts.
$certificateFolderJson = & $nodeCommand $certificateFilesScriptPath
if ($LASTEXITCODE -ne 0) { throw "Certificate folder gate: $certificateFilesScriptPath failed." }
$certificateFolder = ($certificateFolderJson | Out-String) | ConvertFrom-Json
if (-not $certificateFolder.certDir) { throw "Certificate folder gate: $certificateFilesScriptPath printed no certs folder." }
Set-CertificatePaths -CertDir ([string]$certificateFolder.certDir)
foreach ($copiedFile in @($certificateFolder.copied)) {
  if ($copiedFile) { Write-Step "Copied $copiedFile from the old certificate folder" }
}

if ($CheckOnly) {
  if ($RotateCa) { throw "CheckOnly cannot rotate a CA." }
  if (-not (Test-CertificateAuthorityCurrent)) { throw "CA file gate: install a new constrained EveJS CA with Install-EvEJSCerts.ps1 -RotateCa before Play." }
  if ((Test-LeafNeedsRebuild -CertPath $xmppCertPath -KeyPath $xmppKeyPath -RequiredDnsNames @("localhost")) -or
      (Test-LeafNeedsRebuild -CertPath $gatewayCertPath -KeyPath $gatewayKeyPath -RequiredDnsNames $gatewayDnsNames) -or
      (Test-LeafNeedsRebuild -CertPath $gatewayDnsCertPath -KeyPath $gatewayDnsKeyPath -RequiredDnsNames $gatewayDnsNames -DnsOnly)) {
    throw "TLS certificate gate: regenerate the chat and both gateway leaves with Install-EvEJSCerts.ps1 -RotateCa."
  }
  Assert-NoRetiredRoots
  $current = Get-PfxCertificate -FilePath $caCertPath
  if (-not (Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $current.Thumbprint })) {
    throw "CA trust gate: the current EveJS CA is not in CurrentUser\Root. Run Install-EvEJSCerts.ps1 -RotateCa."
  }
  Assert-ClientBundlesCurrent -BundlePaths @(Get-ClientBundlePaths $resolvedClientPath)
  Write-Step "Certificate gate passed: constrained CA, current leaves, Windows trust and client bundles checked."
  exit 0
}

$caArguments = @($builderScriptPath, "--ca-only", "--ensure-ca", "--ca-cert", $caCertPath, "--ca-key", $caKeyPath)
if ($RotateCa) { $caArguments += "--rotate-ca" }
& $nodeCommand @caArguments
if ($LASTEXITCODE -ne 0) { throw "CA file gate: CA generation failed. Use -RotateCa to replace a retired or unconstrained CA." }
Ensure-LocalCertificateFiles

if (-not (Test-Path $caCertPath)) {
  throw "Missing CA certificate at $caCertPath"
}

if (-not (Test-Path $caKeyPath)) {
  throw "Missing CA private key at $caKeyPath"
}

$oldLeafPems = @(Build-GatewayCertificate)

if (-not $ServerFilesOnly) {
  Ensure-RootTrust -PemPath $caCertPath
}

if (-not $ServerFilesOnly) {
  $resolvedClientPath = Resolve-ConfiguredClientPath -ConfiguredPath $ClientPath
  if (-not $resolvedClientPath) {
    throw "Client path was not found. Edit tools\ClientSETUP\scripts\EvEJSConfig.bat or pass -ClientPath."
  }

  $bundlePaths = Get-ClientBundlePaths -ResolvedClientPath $resolvedClientPath
  if (-not $bundlePaths) {
    throw "No client cacert.pem bundle was found under $resolvedClientPath"
  }

  $currentLeafPems = @(foreach ($leafPath in @($gatewayCertPath, $gatewayDnsCertPath)) {
    if (Test-Path -LiteralPath $leafPath) { (Get-Content -LiteralPath $leafPath -Raw).Trim() }
  })

  foreach ($bundlePath in $bundlePaths) {
    Ensure-PemBundleContainsCa `
      -BundlePath $bundlePath `
      -PemCaPath $caCertPath `
      -PemBlocksToRemove @($oldLeafPems + $currentLeafPems)
  }
}

if ($ServerFilesOnly) {
  Write-Step "Server certificate files are ready. Windows trust and client bundles remain unverified; Play requires the full certificate gate."
} else {
  Assert-NoRetiredRoots
  Assert-ClientBundlesCurrent -BundlePaths @(Get-ClientBundlePaths $resolvedClientPath)
  Write-Step "Chat and public-gateway certificates are ready."
}
