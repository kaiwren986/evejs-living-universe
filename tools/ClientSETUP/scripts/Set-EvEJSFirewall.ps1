<#
The two outbound blocks for the EveJS client are recommended, not required.
The launcher uses Check; only an explicit Install can change the firewall.
RemoteServerAddress supports literal-IP remote servers, never local Setup.
It must be a literal IP matching start.ini, so this script never resolves DNS.
FirewallGate is the launcher's EVEJS_FIREWALL_GATE, which Play sets to "warn"
unless the launcher config says "enforce". With "warn", a failed Check prints
a warning and exits 2 instead of 1. Without -FirewallGate the Check is strict
and a failed one exits 1; Setup and a check run by hand rely on that. The
client identity checks always fail with 1.
Windows can refuse the live rule list to an account that is not elevated
(Access is denied). The check then reads the same rules from the saved local
firewall policy in the registry, which every account can read.
#>
[CmdletBinding()]
param(
  [string]$ClientPath,
  [string]$ClientExe,
  [ValidateSet("Check", "Install", "Plan")][string]$Mode = "Check",
  [string]$RemoteServerAddress,
  [string]$FirewallGate = "enforce"
)

$ErrorActionPreference = "Stop"

function Assert-EvEJSLocalPath {
  param([string]$Path)
  $absolute = [IO.Path]::GetFullPath($Path)
  if ($absolute.StartsWith('\\')) { throw "Client identity gate: use a client on a local drive, not $absolute." }
  $cursor = $absolute
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Client identity gate: refusing a junction or symbolic link at $cursor. Use the actual EveJS client copy."
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if (-not $parent) { break }
    $cursor = $parent.FullName
  }
}

function Get-EvEJSClientIdentity {
  param([string]$Path, [string]$ServerAddress = "127.0.0.1")
  if ($Path) { Assert-EvEJSLocalPath $Path }
  if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "Client identity gate: configure an existing EVEJS_CLIENT_PATH in tools\ClientSETUP\scripts\EvEJSConfig.bat."
  }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $iniPath = Join-Path $resolved "start.ini"
  Assert-EvEJSLocalPath $iniPath
  if (-not (Test-Path -LiteralPath $iniPath -PathType Leaf)) {
    throw "Client identity gate: missing $iniPath. Run the EveJS client setup on a separate client copy."
  }
  $values = @{}
  foreach ($line in Get-Content -LiteralPath $iniPath) {
    if ($line -match '^\s*(server|cryptoPack)\s*=(.*)$') {
      $name = $Matches[1].ToLowerInvariant()
      if ($values.ContainsKey($name)) { throw "Client identity gate: duplicate $name in $iniPath." }
      $values[$name] = $Matches[2].Trim()
    }
  }
  if ($values['server'] -cne $ServerAddress -or $values['cryptopack'] -cne "Placebo") {
    throw "Client identity gate: refusing this install. $iniPath must contain server = $ServerAddress and cryptoPack = Placebo. Do not use a live EVE install."
  }
  $programs = @("bin64\exefile.exe", "bin64\eve_crashmon.exe") | ForEach-Object {
    $program = Join-Path $resolved $_
    Assert-EvEJSLocalPath $program
    if (-not (Test-Path -LiteralPath $program -PathType Leaf)) { throw "Client identity gate: missing $program." }
    (Resolve-Path -LiteralPath $program).Path
  }
  return [pscustomobject]@{ ClientPath = $resolved; Programs = @($programs) }
}

function ConvertTo-EvEJSAddressNumber {
  param([System.Net.IPAddress]$Address)
  $bytes = $Address.GetAddressBytes()
  [array]::Reverse($bytes)
  $unsigned = New-Object byte[] ($bytes.Length + 1)
  [array]::Copy($bytes, $unsigned, $bytes.Length)
  return [System.Numerics.BigInteger]::new($unsigned)
}

function ConvertFrom-EvEJSAddressNumber {
  param([System.Numerics.BigInteger]$Number, [int]$Length)
  $little = $Number.ToByteArray()
  $bytes = New-Object byte[] $Length
  [array]::Copy($little, $bytes, [Math]::Min($Length, $little.Length))
  [array]::Reverse($bytes)
  return ([System.Net.IPAddress]::new($bytes)).ToString()
}

function Get-EvEJSBlockedAddressRanges {
  param([string]$ServerAddress)
  Add-Type -AssemblyName System.Numerics
  $serverIp = $null
  if (-not [System.Net.IPAddress]::TryParse($ServerAddress, [ref]$serverIp) -or
    ($serverIp.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6 -and $serverIp.ScopeId -gt 0)) {
    throw "Firewall address gate: RemoteServerAddress must be an unscoped literal IPv4 or IPv6 address."
  }
  foreach ($length in @(4, 16)) {
    $maximum = [System.Numerics.BigInteger]::Pow(2, $length * 8) - 1
    $allowed = @()
    if ($length -eq 4) {
      $allowed += [pscustomobject]@{ Start = (ConvertTo-EvEJSAddressNumber ([System.Net.IPAddress]::Parse("127.0.0.0"))); End = (ConvertTo-EvEJSAddressNumber ([System.Net.IPAddress]::Parse("127.255.255.255"))) }
    } else {
      $allowed += [pscustomobject]@{ Start = [System.Numerics.BigInteger]::One; End = [System.Numerics.BigInteger]::One }
    }
    if ($serverIp.GetAddressBytes().Length -eq $length) {
      $number = ConvertTo-EvEJSAddressNumber $serverIp
      $allowed += [pscustomobject]@{ Start = $number; End = $number }
    }
    $cursor = [System.Numerics.BigInteger]::Zero
    foreach ($range in ($allowed | Sort-Object Start)) {
      if ($range.Start -gt $cursor) {
        "$(ConvertFrom-EvEJSAddressNumber $cursor $length)-$(ConvertFrom-EvEJSAddressNumber ($range.Start - 1) $length)"
      }
      if ($range.End -ge $cursor) { $cursor = $range.End + 1 }
    }
    if ($cursor -le $maximum) {
      "$(ConvertFrom-EvEJSAddressNumber $cursor $length)-$(ConvertFrom-EvEJSAddressNumber $maximum $length)"
    }
  }
}

function Get-EvEJSFirewallRuleName {
  param([string]$Program)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hash = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Program.ToLowerInvariant())) }
  finally { $sha.Dispose() }
  return "EveJS-Offline-$(([BitConverter]::ToString($hash) -replace '-', '').Substring(0, 16))"
}

function Get-EvEJSNormalizedAddresses {
  param([string[]]$Addresses)
  Add-Type -AssemblyName System.Numerics
  $ranges = @()
  foreach ($entry in $Addresses) {
    if ($entry -eq "Any") {
      foreach ($length in @(4, 16)) {
        $ranges += [pscustomobject]@{ Length = $length; Start = [System.Numerics.BigInteger]::Zero; End = ([System.Numerics.BigInteger]::Pow(2, $length * 8) - 1) }
      }
      continue
    }
    $parts = $entry -split '[-/]'
    $address = $null
    if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$address)) {
      throw "Firewall address gate: unrecognised address filter $entry. Reinstall the EveJS rules."
    }
    $length = $address.GetAddressBytes().Length
    $first = ConvertTo-EvEJSAddressNumber $address
    $last = $first
    if ($entry.Contains('/')) {
      $prefix = 0
      if ($parts.Count -ne 2 -or -not [int]::TryParse($parts[1], [ref]$prefix) -or $prefix -lt 0 -or $prefix -gt $length * 8) {
        throw "Firewall address gate: invalid network filter $entry."
      }
      $size = [System.Numerics.BigInteger]::Pow(2, $length * 8 - $prefix)
      $first = [System.Numerics.BigInteger]::Divide($first, $size) * $size
      $last = $first + $size - 1
    } elseif ($entry.Contains('-')) {
      $endAddress = $null
      if ($parts.Count -ne 2 -or -not [System.Net.IPAddress]::TryParse($parts[1], [ref]$endAddress) -or $endAddress.GetAddressBytes().Length -ne $length) {
        throw "Firewall address gate: invalid address range $entry."
      }
      $last = ConvertTo-EvEJSAddressNumber $endAddress
      if ($last -lt $first) { throw "Firewall address gate: reversed address range $entry." }
    }
    $ranges += [pscustomobject]@{ Length = $length; Start = $first; End = $last }
  }
  foreach ($length in @(4, 16)) {
    $merged = $null
    foreach ($range in @($ranges | Where-Object { $_.Length -eq $length } | Sort-Object Start, End)) {
      if ($merged -and $range.Start -le $merged.End + 1) {
        if ($range.End -gt $merged.End) { $merged.End = $range.End }
      } else {
        if ($merged) { "$length`:$($merged.Start)-$($merged.End)" }
        $merged = $range
      }
    }
    if ($merged) { "$length`:$($merged.Start)-$($merged.End)" }
  }
}

function Assert-EvEJSFirewallService {
  if ((Get-Service -Name MpsSvc).Status -ne "Running") {
    throw "Firewall service gate: Windows Defender Firewall (MpsSvc) is not running. The EveJS blocks only work while it runs."
  }
  $activeNames = @(Get-NetConnectionProfile | ForEach-Object {
    if ([string]$_.NetworkCategory -eq "DomainAuthenticated") { "Domain" } else { [string]$_.NetworkCategory }
  } | Sort-Object -Unique)
  $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
  if ($profiles.Count -ne 3) { throw "Firewall profile gate: could not read all effective Windows firewall profiles." }
  foreach ($profile in $profiles) {
    if (($activeNames.Count -eq 0 -or $activeNames -contains [string]$profile.Name) -and [string]$profile.Enabled -ne "True") {
      throw "Firewall profile gate: the $($profile.Name) Windows firewall profile is off. The EveJS blocks only work while it is on."
    }
    if (($activeNames.Count -eq 0 -or $activeNames -contains [string]$profile.Name) -and [string]$profile.AllowLocalFirewallRules -eq "False") {
      throw "Firewall profile gate: $($profile.Name) policy ignores local firewall rules. Have the administrator enable local rules or deploy equivalent EveJS blocks through policy."
    }
  }
}

$EvEJSSavedFirewallRulesKey = "HKLM:\SYSTEM\CurrentControlSet\Services\SharedAccess\Parameters\FirewallPolicy\FirewallRules"

function Get-EvEJSSavedFirewallRule {
  param([string]$Name)
  $saved = Get-ItemProperty -LiteralPath $EvEJSSavedFirewallRulesKey -Name $Name -ErrorAction SilentlyContinue
  if ($saved) { return [string]$saved.$Name }
  return $null
}

function Test-EvEJSSavedFirewallRule {
  # A saved rule reads like "v2.30|Action=Block|Active=TRUE|Dir=Out|App=...|Name=...|EmbedCtxt=EveJS|".
  # A missing field means Any. Any field outside this list narrows the block
  # (profile, protocol, port, local address, interface, service, package, user
  # or security), so it fails here as the same filter fails the live check.
  param([string]$Rule, [string]$Program, [string[]]$RemoteAddresses)
  $tokens = @($Rule -split '\|' | Where-Object { $_ })
  if ($tokens.Count -eq 0 -or $tokens[0] -notmatch '^v\d+\.\d+$') { return $false }
  $fields = @{}
  $remote = @()
  foreach ($token in @($tokens | Select-Object -Skip 1)) {
    $split = $token.IndexOf('=')
    if ($split -lt 1) { return $false }
    $key = $token.Substring(0, $split)
    $value = $token.Substring($split + 1)
    if ($key -in @("RA4", "RA6")) { $remote += $value; continue }
    if ($key -notin @("Action", "Active", "Dir", "App", "Name", "Desc", "EmbedCtxt") -or $fields.ContainsKey($key)) { return $false }
    $fields[$key] = $value
  }
  if ($remote.Count -eq 0) { $remote = @("Any") }
  $actualAddresses = @(Get-EvEJSNormalizedAddresses $remote)
  $expectedAddresses = @(Get-EvEJSNormalizedAddresses $RemoteAddresses)
  return ($fields["Active"] -eq "TRUE" -and $fields["Action"] -eq "Block" -and $fields["Dir"] -eq "Out" -and
    $fields["EmbedCtxt"] -eq "EveJS" -and [Environment]::ExpandEnvironmentVariables([string]$fields["App"]) -ieq $Program -and
    ($actualAddresses -join ',') -eq ($expectedAddresses -join ','))
}

function Assert-EvEJSFirewallRules {
  param([string[]]$Programs, [string[]]$RemoteAddresses)
  Assert-EvEJSFirewallService
  foreach ($program in $Programs) {
    $ruleName = Get-EvEJSFirewallRuleName $program
    $rules = @()
    $savedOnly = $false
    try { $rules = @(Get-NetFirewallRule -PolicyStore ActiveStore -Name $ruleName -ErrorAction Stop) }
    catch { $savedOnly = ($_.CategoryInfo.Category -eq "PermissionDenied") }
    $valid = $false
    if ($savedOnly) {
      # The saved rule cannot show whether Windows enforces it. The service and
      # profile gates above cover the firewall being on and honouring local rules.
      $script:EvEJSFirewallReadSavedRules = $true
      $valid = Test-EvEJSSavedFirewallRule -Rule (Get-EvEJSSavedFirewallRule $ruleName) -Program $program -RemoteAddresses $RemoteAddresses
    } elseif ($rules.Count -eq 1) {
      $rule = $rules[0]
      $app = $rule | Get-NetFirewallApplicationFilter
      $address = $rule | Get-NetFirewallAddressFilter
      $port = $rule | Get-NetFirewallPortFilter
      $interface = $rule | Get-NetFirewallInterfaceFilter
      $interfaceType = $rule | Get-NetFirewallInterfaceTypeFilter
      $service = $rule | Get-NetFirewallServiceFilter
      $security = $rule | Get-NetFirewallSecurityFilter
      $actualAddresses = @(Get-EvEJSNormalizedAddresses @($address.RemoteAddress))
      $expectedAddresses = @(Get-EvEJSNormalizedAddresses $RemoteAddresses)
      $valid = ([string]$rule.Enabled -eq "True" -and [string]$rule.Action -eq "Block" -and
        [string]$rule.Direction -eq "Outbound" -and [string]$rule.Profile -eq "Any" -and
        [string]$rule.PrimaryStatus -eq "OK" -and @($rule.EnforcementStatus | ForEach-Object { [string]$_ }) -contains "Enforced" -and
        $rule.Group -eq "EveJS" -and $app.Program -ieq $program -and [string]$app.Package -in @("", "Any") -and
        [string]$port.Protocol -eq "Any" -and [string]$port.LocalPort -eq "Any" -and
        [string]$port.RemotePort -eq "Any" -and [string]$address.LocalAddress -eq "Any" -and
        [string]$interface.InterfaceAlias -eq "Any" -and [string]$interfaceType.InterfaceType -eq "Any" -and
        [string]$service.Service -eq "Any" -and [string]$security.Authentication -eq "NotRequired" -and
        [string]$security.LocalUser -eq "Any" -and [string]$security.RemoteUser -eq "Any" -and [string]$security.RemoteMachine -eq "Any" -and
        ($actualAddresses -join ',') -eq ($expectedAddresses -join ','))
    }
    if (-not $valid) {
      throw "Firewall rule gate: missing or changed outbound block for $program. Run SetupEveJS.bat -Only firewall and approve its single UAC prompt."
    }
  }
}

function Get-EvEJSFirewallGate {
  param([string]$Value)
  # No trimming: Play.bat compares the same raw value, and both must agree.
  if ($Value -eq "") { return "enforce" }
  if ($Value -notin @("enforce", "warn")) {
    throw "Firewall gate setting: EVEJS_FIREWALL_GATE must be enforce or warn, not '$Value'. Fix it in tools\ClientSETUP\scripts\EvEJSConfig.bat."
  }
  return $Value.ToLowerInvariant()
}

function Invoke-EvEJSFirewall {
  $script:EvEJSFirewallGateWarned = $false
  $script:EvEJSFirewallReadSavedRules = $false
  $gate = Get-EvEJSFirewallGate $FirewallGate
  $serverAddress = "127.0.0.1"
  $remoteAddresses = @("Any")
  if ($RemoteServerAddress) {
    $remoteAddresses = @(Get-EvEJSBlockedAddressRanges $RemoteServerAddress)
    $serverAddress = $RemoteServerAddress
  }
  # Identity validation always happens before elevation or any mutation.
  $identity = Get-EvEJSClientIdentity -Path $ClientPath -ServerAddress $serverAddress
  if ($ClientExe -and [IO.Path]::GetFullPath($ClientExe) -ine $identity.Programs[0]) {
    throw "Client executable gate: EVEJS_CLIENT_EXE must be $($identity.Programs[0]). Do not launch a different or live EVE install."
  }
  if ($Mode -eq "Plan") {
    [pscustomobject]@{ Programs = $identity.Programs; BlockedAddresses = $remoteAddresses } | ConvertTo-Json
    return
  }
  if ($Mode -eq "Install") {
    try {
      Assert-EvEJSFirewallRules -Programs $identity.Programs -RemoteAddresses $remoteAddresses
      Write-Host "[eve.js] Firewall gate passed: existing rules are current."
      return
    } catch {
      # The explicit installer repairs missing or changed rules below.
    }
    # Rules cannot work while Windows Firewall is off, so stop before the administrator prompt.
    Assert-EvEJSFirewallService
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Mode', 'Install', '-ClientPath', ('"{0}"' -f $identity.ClientPath))
      if ($RemoteServerAddress) { $arguments += @('-RemoteServerAddress', $RemoteServerAddress) }
      $child = Start-Process -FilePath (Join-Path $PSHOME "powershell.exe") -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
      if ($child.ExitCode -ne 0) { throw "Firewall install failed or was cancelled. Run SetupEveJS.bat -Only firewall from an elevated PowerShell window." }
    } else {
      $running = @(Get-CimInstance Win32_Process -Filter "Name='exefile.exe' OR Name='eve_crashmon.exe'" | Where-Object { $_.ExecutablePath -and $identity.Programs -icontains $_.ExecutablePath })
      if ($running.Count -gt 0) { throw "Firewall install gate: close the EveJS client and its crash handler before replacing their rules." }
      foreach ($program in $identity.Programs) {
        $ruleName = Get-EvEJSFirewallRuleName $program
        $existing = Get-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -ErrorAction SilentlyContinue
        if ($existing) { $existing | Remove-NetFirewallRule }
        New-NetFirewallRule -PolicyStore PersistentStore -Name $ruleName -DisplayName "EveJS offline: $([IO.Path]::GetFileName($program))" -Group "EveJS" -Enabled True -Action Block -Direction Outbound -Profile Any -Protocol Any -Program $program -RemoteAddress $remoteAddresses | Out-Null
      }
    }
  }
  if ($Mode -eq "Check" -and $gate -eq "warn") {
    try {
      Assert-EvEJSFirewallRules -Programs $identity.Programs -RemoteAddresses $remoteAddresses
    } catch {
      Write-Host "[eve.js] Firewall check failed: $($_.Exception.Message)"
      Write-Host "[eve.js] WARNING: Windows Firewall is not blocking the EveJS client. The two blocks are recommended, not required, so Play starts anyway."
      Write-Host "[eve.js] Run SetupEveJS.bat -Only firewall to add them. Without them, anything the client patches and the proxy miss can reach the internet."
      $script:EvEJSFirewallGateWarned = $true
      return
    }
  } else {
    Assert-EvEJSFirewallRules -Programs $identity.Programs -RemoteAddresses $remoteAddresses
  }
  $source = ""
  if ($script:EvEJSFirewallReadSavedRules) { $source = " Rules read from the saved local firewall policy, because Windows shows the live rules only to an administrator." }
  Write-Host "[eve.js] Firewall gate passed: both client programs blocked; firewall service and active profiles enabled.$source"
}

if ($MyInvocation.InvocationName -ne ".") {
  try { Invoke-EvEJSFirewall }
  catch { Write-Host "[eve.js] $($_.Exception.Message)"; exit 1 }
  if ($script:EvEJSFirewallGateWarned) { exit 2 }
}
