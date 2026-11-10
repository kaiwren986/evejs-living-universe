# Capture evidence only. This script never launches the client, changes a
# firewall rule, or changes certificate trust. Run Begin and End elevated.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Begin', 'End', 'Restore', 'Report', 'Library')][string]$Mode,
    [string]$ClientPath,
    [int]$ServerProcessId,
    [int]$ServerPort = 26000,
    [string]$OutputDirectory,
    [string[]]$ServerAddress = @('127.0.0.1', '::1')
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Test-EvEJSAllowedAddress {
    param([string]$Address, [string[]]$AllowedAddresses)
    $parsed = $null
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
    if ($parsed.IsIPv4MappedToIPv6) { $parsed = $parsed.MapToIPv4() }
    if ([System.Net.IPAddress]::IsLoopback($parsed)) { return $true }
    foreach ($allowed in $AllowedAddresses) {
        $allowedIp = $null
        if (-not [System.Net.IPAddress]::TryParse($allowed, [ref]$allowedIp)) { continue }
        if ($allowedIp.IsIPv4MappedToIPv6) { $allowedIp = $allowedIp.MapToIPv4() }
        if ($parsed.Equals($allowedIp)) { return $true }
    }
    return $false
}

function ConvertTo-EvEJSApplicationPath {
    param([string]$Application, [object[]]$DevicePaths)
    $value = $Application.Replace('/', '\')
    if ($value.StartsWith('\??\')) { $value = $value.Substring(4) }
    foreach ($mapping in @($DevicePaths | Sort-Object { $_.Device.Length } -Descending)) {
        $prefix = [string]$mapping.Device
        if ($value.Equals($prefix, [StringComparison]::OrdinalIgnoreCase) -or
            $value.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) {
            $value = [string]$mapping.Drive + $value.Substring($prefix.Length)
            break
        }
    }
    return $value.TrimEnd('\').ToLowerInvariant()
}

function ConvertTo-EvEJSEventRecord {
    param($Event)
    [xml]$xml = $Event.ToXml()
    $data = @{}
    foreach ($entry in @($xml.SelectNodes("//*[local-name()='EventData']/*[local-name()='Data']"))) {
        if ($null -ne $entry -and $entry.HasAttribute('Name')) { $data[$entry.Name] = $entry.InnerText }
    }
    return [pscustomobject]@{
        Provider = [string]$xml.Event.System.Provider.Name
        Id = [int]$Event.Id
        Time = $Event.TimeCreated.ToUniversalTime().ToString('o')
        HeaderProcessId = [string]$xml.Event.System.Execution.ProcessID
        Data = $data
    }
}

function Test-EvEJSForbiddenDnsName {
    param([string]$Name)
    return $Name -match '(?i)(^|\.)(?:launchdarkly\.(?:com|us|eu)|sentry\.io|ipify\.org|eveonline\.com|evetech\.net)\.?$'
}

function Test-EvEJSCaptureClientIdentity {
    param([string]$StartIni)
    $serverValues = @([regex]::Matches($StartIni, '(?im)^\s*server\s*=\s*([^\r\n]*)'))
    $cryptoValues = @([regex]::Matches($StartIni, '(?im)^\s*cryptoPack\s*=\s*([^\r\n]*)'))
    return $serverValues.Count -eq 1 -and $cryptoValues.Count -eq 1 -and
        $serverValues[0].Groups[1].Value.Trim() -eq '127.0.0.1' -and
        $cryptoValues[0].Groups[1].Value.Trim() -ceq 'Placebo'
}

function Get-EvEJSCaptureSecurityEvents {
    param([datetime]$Start, [datetime]$End)
    try {
        Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = @(1102,5152,5156,5157); StartTime = $Start; EndTime = $End } -ErrorAction Stop
    } catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    }
}

function Get-EvEJSCaptureSecurityHealth {
    param([datetime]$Start, [datetime]$Through)
    $queryStarted = [datetime]::UtcNow
    $ids = @(1100,1101,1102,1104,1108,4612,4621)
    $events = @()
    try {
        $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Security'; Id = $ids; StartTime = $Start; EndTime = $Through } -ErrorAction Stop)
    } catch {
        if ($_.FullyQualifiedErrorId -notlike 'NoMatchingEventsFound*') { throw }
    }
    $records = @(foreach ($event in $events) {
        $rawXml = $event.ToXml()
        [xml]$xml = $rawXml
        $data = @{}
        foreach ($entry in @($xml.SelectNodes("//*[local-name()='EventData']/*[local-name()='Data'] | //*[local-name()='UserData']//*[not(*)]"))) {
            $name = if ($entry.HasAttribute('Name')) { $entry.GetAttribute('Name') } else { $entry.LocalName }
            $data[$name] = $entry.InnerText
        }
        [pscustomobject]@{
            Id = [int]$event.Id; RecordId = [long]$event.RecordId; Provider = [string]$event.ProviderName
            TimeUtc = $event.TimeCreated.ToUniversalTime().ToString('o')
            Message = [string]$event.Message; Data = $data; Xml = $rawXml
        }
    })
    return [pscustomobject]@{
        StartUtc = $Start.ToUniversalTime().ToString('o'); ThroughUtc = $Through.ToUniversalTime().ToString('o')
        QueryStartedUtc = $queryStarted.ToString('o'); QueryCompletedUtc = [datetime]::UtcNow.ToString('o')
        EventIds = $ids; Events = $records
        Errors = @($records | ForEach-Object { "Security audit health event $($_.Id), record $($_.RecordId): $($_.Message)" })
    }
}

function New-EvEJSSecurityLogConfiguration {
    return [Diagnostics.Eventing.Reader.EventLogConfiguration]::new('Security')
}

function Get-EvEJSSecurityLogInformation {
    return [Diagnostics.Eventing.Reader.EventLogSession]::GlobalSession.GetLogInformation('Security', [Diagnostics.Eventing.Reader.PathType]::LogName)
}

function Get-EvEJSSecurityLogSettings {
    $configuration = New-EvEJSSecurityLogConfiguration
    try {
        $maximum = [long]$configuration.MaximumSizeInBytes
        if ($maximum -le 0) { throw 'Security log maximum size is unavailable or nonpositive.' }
        return [pscustomobject]@{ MaximumSizeInBytes = $maximum; LogMode = [string]$configuration.LogMode }
    } finally { $configuration.Dispose() }
}

function Set-EvEJSSecurityLogMaximum {
    param([long]$MaximumSizeInBytes)
    if ($MaximumSizeInBytes -le 0) { throw 'Refusing a nonpositive Security log maximum size.' }
    $configuration = New-EvEJSSecurityLogConfiguration
    try {
        if ([long]$configuration.MaximumSizeInBytes -le 0) { throw 'Security log maximum size is unavailable or nonpositive.' }
        $modeBefore = [string]$configuration.LogMode
        # Change only capacity. Never clear the Security log or change retention.
        $configuration.MaximumSizeInBytes = $MaximumSizeInBytes
        $configuration.SaveChanges()
    } finally { $configuration.Dispose() }
    $readback = Get-EvEJSSecurityLogSettings
    if ($readback.MaximumSizeInBytes -ne $MaximumSizeInBytes -or $readback.LogMode -cne $modeBefore) {
        throw 'Security log size or retention readback differs from the requested settings.'
    }
}

function Restore-EvEJSSecurityLogMaximum {
    param($State)
    # Old captures did not change capacity and therefore have nothing to restore.
    $hasSaved = if ($State -is [Collections.IDictionary]) { $State.Contains('SecurityLogBefore') }
        else { $null -ne $State.PSObject.Properties['SecurityLogBefore'] }
    if ($hasSaved) { Set-EvEJSSecurityLogMaximum -MaximumSizeInBytes $State.SecurityLogBefore.MaximumSizeInBytes }
}

function Get-EvEJSSecurityLogCapacityErrors {
    param([long]$ExpectedMaximumSizeInBytes = 0)
    $settings = Get-EvEJSSecurityLogSettings
    $information = Get-EvEJSSecurityLogInformation
    if ($null -eq $information.FileSize -or [long]$information.FileSize -le 0 -or $null -eq $information.IsLogFull) {
        throw 'Security log capacity information is unavailable.'
    }
    if ($ExpectedMaximumSizeInBytes -gt 0 -and $settings.MaximumSizeInBytes -ne $ExpectedMaximumSizeInBytes) {
        'Security log maximum size changed during capture; evidence may be incomplete.'
    }
    if ($information.IsLogFull -or [long]$information.FileSize -ge $settings.MaximumSizeInBytes) {
        'Security log reached its capacity during capture; WFP evidence may be incomplete.'
    }
}

function Get-EvEJSFirewallTextLogLossErrors {
    param([string[]]$Path, [datetime]$Start, [datetime]$End, [switch]$CaptureOwned)
    $startUtc = $Start.ToUniversalTime()
    $endUtc = $End.ToUniversalTime()
    foreach ($logPath in $Path) {
        $timeFormat = $null
        foreach ($line in Get-Content -LiteralPath $logPath -ErrorAction Stop) {
            if ($line -match '^#Time Format:\s*(.*?)\s*$') { $timeFormat = $Matches[1]; continue }
            if ($line -notmatch '(?:^|\s)INFO-EVENTS-LOST(?:\s|$)') { continue }
            if ($CaptureOwned) {
                # A fresh sink has no historical traffic. Windows can emit a
                # loss marker after End while flushing an earlier batch.
                "Firewall text log lost events during capture: $logPath : $line"
                continue
            }
            if ($timeFormat -notin @('Local','UTC')) {
                "Firewall text log has lost events with an unknown time format: $logPath"
                continue
            }
            $timestamp = [datetime]::MinValue
            if ($line -notmatch '^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+INFO-EVENTS-LOST(?:\s|$)' -or
                -not [datetime]::TryParseExact($Matches[1], 'yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$timestamp)) {
                "Firewall text log has lost events with an unreadable timestamp: $logPath"
                continue
            }
            $kind = if ($timeFormat -eq 'UTC') { [DateTimeKind]::Utc } else { [DateTimeKind]::Local }
            $timestamp = [datetime]::SpecifyKind($timestamp, $kind).ToUniversalTime()
            # Text logs have one-second precision. Include any overlapping second.
            if ($timestamp -le $endUtc -and $timestamp.AddSeconds(1) -gt $startUtc) {
                "Firewall text log lost events during capture: $logPath : $line"
            }
        }
    }
}

function Get-EvEJSActiveFirewallProfiles {
    $names = @(foreach ($connection in Get-NetConnectionProfile -ErrorAction Stop) {
        switch ([string]$connection.NetworkCategory) {
            'DomainAuthenticated' { 'Domain' }
            'Private' { 'Private' }
            'Public' { 'Public' }
            default { throw 'Cannot identify the active firewall profile for a network connection.' }
        }
    })
    $names = @($names | Sort-Object -Unique)
    if (-not $names.Count) { throw 'Cannot identify an active firewall profile for this capture.' }
    return $names
}

function New-EvEJSFirewallCaptureLogPlan {
    param([object[]]$Profiles, [guid]$CaptureId, [string]$Directory = (Join-Path ([Environment]::SystemDirectory) 'LogFiles\Firewall'))
    $directoryItem = Get-Item -LiteralPath $Directory -ErrorAction Stop
    if (-not $directoryItem.PSIsContainer -or ($directoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Use the existing local Windows Firewall log directory; it must not be a link.'
    }
    if ($CaptureId -eq [guid]::Empty -or $Profiles.Count -ne 3 -or @($Profiles.Name | Sort-Object -Unique).Count -ne 3) {
        throw 'Capture logging requires a fresh capture ID and all three firewall profiles.'
    }
    foreach ($profile in $Profiles) {
        if ([string]$profile.Name -cnotin @('Domain','Private','Public')) { throw 'Unexpected firewall profile name.' }
        $logPath = Join-Path $directoryItem.FullName ('EvEJS-{0}-{1}.log' -f $CaptureId.ToString('N'), $profile.Name)
        if ((Test-Path -LiteralPath $logPath) -or (Test-Path -LiteralPath ($logPath + '.old'))) { throw "Capture log already exists: $logPath" }
        # MpsSvc creates its own files in its existing protected log directory.
        # Do not synthesize empty files for inactive profiles.
        [pscustomobject]@{ Name=[string]$profile.Name; LogFileName=$logPath; LogAllowed=1; LogBlocked=1; LogMaxSizeKilobytes=32767 }
    }
}

function Assert-EvEJSFirewallCaptureLogging {
    param([object[]]$Profiles)
    foreach ($profile in $Profiles) {
        $current = Get-NetFirewallProfile -PolicyStore ActiveStore -Name $profile.Name -ErrorAction Stop
        if ([int]$current.LogAllowed -ne 1 -or [int]$current.LogBlocked -ne 1 -or
            [Environment]::ExpandEnvironmentVariables($current.LogFileName) -ine $profile.LogFileName -or
            [int]$current.LogMaxSizeKilobytes -ne [int]$profile.LogMaxSizeKilobytes) {
            throw "Effective firewall capture logging differs from its requested settings: $($profile.Name)"
        }
    }
}

function Get-EvEJSFirewallCaptureLogSources {
    param($State, [string[]]$ActiveProfilesAfter)
    $fresh = $null -ne $State.PSObject.Properties['ProfilesDuring']
    $profiles = if ($fresh) { $State.ProfilesDuring } else { $State.ProfilesBefore }
    foreach ($profile in $profiles) {
        $required = (-not $fresh) -or $State.ActiveProfilesBefore -contains $profile.Name -or $ActiveProfilesAfter -contains $profile.Name
        [pscustomobject]@{ Name=$profile.Name; SourcePath=[Environment]::ExpandEnvironmentVariables($profile.LogFileName); Required=[bool]$required }
    }
}

function Copy-EvEJSClosedFirewallLog {
    param([string]$Source, [string]$Destination, [ValidateRange(0,10000)][int]$WaitMilliseconds = 5000)
    $deadline = [datetime]::UtcNow.AddMilliseconds($WaitMilliseconds)
    $inputStream = $null
    while ($null -eq $inputStream) {
        try { $inputStream = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if ([datetime]::UtcNow -ge $deadline) { throw "Firewall log writer did not close before evidence copy: $Source. $($_.Exception.Message)" }
            Start-Sleep -Milliseconds 200
        }
    }
    try {
        $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream); $outputStream.Flush($true) }
        finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
}

function Get-EvEJSTraceLossErrors {
    param($Statistics)
    if (-not $Statistics.Before -or -not $Statistics.After) { 'Trace counters are incomplete.' }
    foreach ($phase in @('Before','After')) {
        $counters = $Statistics.$phase
        if (-not $counters) { continue }
        foreach ($name in @('EventsLost','LogBuffersLost','RealTimeBuffersLost')) {
            if ([uint64]$counters.$name -gt 0) { "$phase $name=$($counters.$name)" }
        }
    }
}

function Get-EvEJSCaptureReportStatus {
    param([string[]]$Issues, [string[]]$CaptureErrors, [string]$RestoreError, [string[]]$StopErrors)
    if (@($Issues).Count -or @($CaptureErrors).Count -or $RestoreError -or @($StopErrors).Count) { return 'FAIL' }
    return 'REVIEW_REQUIRED'
}

function Read-EvEJSCaptureJsonArray {
    param([string]$Path)
    $raw = Get-Content -Raw -LiteralPath $Path -ErrorAction Stop
    if ($raw -notmatch '^\s*\[') { throw "Capture artifact must contain a JSON array: $Path" }
    $decoded = ConvertFrom-Json -InputObject $raw -ErrorAction Stop
    # Windows PowerShell 5 emits a JSON array as one pipeline object, including
    # an empty array. Enumerate explicitly before callers wrap the result in @().
    foreach ($entry in $decoded) {
        if ($null -eq $entry -or $entry -is [array]) { throw "Capture artifact must contain a flat JSON array: $Path" }
        Write-Output -NoEnumerate $entry
    }
}

if ($Mode -eq 'Library') { return }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) { throw 'Supply -OutputDirectory for this capture.' }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$statePath = Join-Path $OutputDirectory 'capture-state.json'

function Write-CaptureJson {
    param([string]$Path, $Value)
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 20), [Text.UTF8Encoding]::new($false))
}

function Invoke-CaptureCommand {
    param([string]$Command, [string[]]$Arguments)
    # Windows PowerShell 5 treats redirected native stderr as ErrorRecord.
    # Inspect the native exit code ourselves so cleanup can retain its errors.
    $ErrorActionPreference = 'Continue'
    $output = & $Command @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "$Command failed ($LASTEXITCODE): $output" }
    return $output
}

function Test-CaptureSession {
    param([string]$Name)
    $ErrorActionPreference = 'Continue'
    $output = & logman.exe query $Name -ets 2>&1
    if ($LASTEXITCODE -eq 0) { return $true }
    # PLA_E_DCS_NOT_FOUND, verified against logman's native exit status. Other
    # errors (including access denied) cannot establish that a trace stopped.
    if ($LASTEXITCODE -eq -2144337918) { return $false }
    throw "Cannot determine whether trace $Name is running ($LASTEXITCODE): $output"
}

function Stop-CaptureSession {
    param([string]$Name, [string]$StatisticsPath, [switch]$AllowAbsent)
    if (-not (Test-CaptureSession $Name)) {
        if ($AllowAbsent) { return }
        throw "Trace $Name stopped before End; its evidence may be incomplete."
    }
    $statistics = [ordered]@{ Name = $Name; Before = $null; After = $null; Stopped = $false; FallbackUsed = $false; Errors = @() }
    try { $statistics.Before = [EvEJSOfflineCaptureNative]::TraceStatistics($Name, $false) }
    catch { $statistics.Errors += "Counter query: $_" }
    # A failed counter query must not prevent stopping the owned trace.
    try { $statistics.After = [EvEJSOfflineCaptureNative]::TraceStatistics($Name, $true) }
    catch { $statistics.Errors += "Trace stop: $_" }
    try { $statistics.Stopped = -not (Test-CaptureSession $Name) }
    catch { $statistics.Errors += "Stop readback: $_" }
    if (-not $statistics.Stopped) {
        # Keep cleanup independent of the native counter ABI. A fallback stop
        # cannot recover missing counters, so the original errors still fail
        # the capture even when this confirms that the session is gone.
        $statistics.FallbackUsed = $true
        try { Invoke-CaptureCommand 'logman.exe' @('stop',$Name,'-ets') | Out-Null }
        catch { $statistics.Errors += "Fallback trace stop: $_" }
        try { $statistics.Stopped = -not (Test-CaptureSession $Name) }
        catch { $statistics.Errors += "Fallback stop readback: $_" }
    }
    if (-not $statistics.Stopped) { $statistics.Errors += "Trace $Name is not confirmed stopped." }
    Write-CaptureJson $StatisticsPath $statistics
    if ($statistics.Errors.Count) { throw ($statistics.Errors -join [Environment]::NewLine) }
}

function Initialize-CaptureNative {
    if ('EvEJSOfflineCaptureNative' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class EvEJSOfflineCaptureNative {
    [StructLayout(LayoutKind.Sequential)] struct AuditInfo { public Guid Id; public uint Bits; public Guid Category; }
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TokenPrivilege { public uint Count; public Luid Id; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct WnodeHeader {
        public uint BufferSize; public uint ProviderId; public ulong HistoricalContext; public long TimeStamp;
        public Guid Guid; public uint ClientContext; public uint Flags;
    }
    [StructLayout(LayoutKind.Sequential)] struct TraceProperties {
        public WnodeHeader Wnode;
        public uint BufferSize; public uint MinimumBuffers; public uint MaximumBuffers; public uint MaximumFileSize;
        public uint LogFileMode; public uint FlushTimer; public uint EnableFlags; public int AgeLimit;
        public uint NumberOfBuffers; public uint FreeBuffers; public uint EventsLost; public uint BuffersWritten;
        public uint LogBuffersLost; public uint RealTimeBuffersLost; public IntPtr LoggerThreadId;
        public uint LogFileNameOffset; public uint LoggerNameOffset;
    }
    public struct TraceCounters { public uint EventsLost; public uint LogBuffersLost; public uint RealTimeBuffersLost; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disable, ref TokenPrivilege state, uint length, IntPtr previous, IntPtr returned);
    [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.U1)] static extern bool AuditQuerySystemPolicy(ref Guid id, uint count, out IntPtr info);
    [DllImport("advapi32.dll", SetLastError=true)] [return: MarshalAs(UnmanagedType.U1)] static extern bool AuditSetSystemPolicy(ref AuditInfo info, uint count);
    [DllImport("advapi32.dll")] static extern void AuditFree(IntPtr info);
    [DllImport("advapi32.dll", EntryPoint="ControlTraceW", CharSet=CharSet.Unicode)]
    static extern uint ControlTrace(ulong handle, string name, IntPtr properties, uint control);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint QueryDosDevice(string name, StringBuilder target, int size);
    static void EnableAuditPrivilege() {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception();
        try {
            Luid id;
            if (!LookupPrivilegeValue(null, "SeSecurityPrivilege", out id)) throw new Win32Exception();
            var state = new TokenPrivilege { Count=1, Id=id, Attributes=2 };
            if (!AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
            if (Marshal.GetLastWin32Error() == 1300) throw new Win32Exception(1300);
        } finally { CloseHandle(token); }
    }
    public static uint GetAudit(Guid id) {
        EnableAuditPrivilege();
        IntPtr ptr;
        if (!AuditQuerySystemPolicy(ref id, 1, out ptr)) throw new Win32Exception();
        try { return NormalizeAuditBits(((AuditInfo)Marshal.PtrToStructure(ptr, typeof(AuditInfo))).Bits); }
        finally { AuditFree(ptr); }
    }
    public static void SetAudit(Guid id, uint bits) {
        EnableAuditPrivilege();
        var info = new AuditInfo { Id=id, Bits=AuditSetFlags(bits) };
        if (!AuditSetSystemPolicy(ref info, 1)) throw new Win32Exception();
    }
    public static uint NormalizeAuditBits(uint bits) {
        if (bits > 4) throw new InvalidOperationException("Unsupported audit policy bits.");
        return bits & 3u;
    }
    public static uint AuditSetFlags(uint bits) {
        uint enabled = NormalizeAuditBits(bits);
        // NTSecAPI.h: zero means UNCHANGED when setting; NONE (4) disables.
        // Query returns enabled success/failure bits, so a saved zero needs 4.
        return enabled == 0 ? 4u : enabled;
    }
    public static TraceCounters TraceStatistics(string name, bool stop) {
        int structureSize = Marshal.SizeOf(typeof(TraceProperties));
        int bufferSize = structureSize + 4096;
        IntPtr buffer = Marshal.AllocHGlobal(bufferSize);
        try {
            Marshal.Copy(new byte[bufferSize], 0, buffer, bufferSize);
            var properties = new TraceProperties {
                Wnode=new WnodeHeader { BufferSize=(uint)bufferSize },
                LoggerNameOffset=(uint)structureSize, LogFileNameOffset=(uint)(structureSize + 2048)
            };
            Marshal.StructureToPtr(properties, buffer, false);
            uint result = ControlTrace(0, name, buffer, stop ? 1u : 0u);
            if (result != 0) throw new Win32Exception((int)result);
            properties = (TraceProperties)Marshal.PtrToStructure(buffer, typeof(TraceProperties));
            return new TraceCounters { EventsLost=properties.EventsLost, LogBuffersLost=properties.LogBuffersLost, RealTimeBuffersLost=properties.RealTimeBuffersLost };
        } finally { Marshal.FreeHGlobal(buffer); }
    }
}
'@
}

function Assert-CaptureAdministrator {
    $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this capture command in an elevated PowerShell window.'
    }
}

function Restore-CaptureSettings {
    param($State, [switch]$FirewallOnly)
    $errors = [Collections.Generic.List[string]]::new()
    if (-not $FirewallOnly) { foreach ($audit in $State.AuditBefore) {
        try {
            [EvEJSOfflineCaptureNative]::SetAudit([Guid]$audit.Id, [uint32]$audit.Bits)
            if ([EvEJSOfflineCaptureNative]::GetAudit([Guid]$audit.Id) -ne [EvEJSOfflineCaptureNative]::NormalizeAuditBits([uint32]$audit.Bits)) { throw 'Audit policy readback differs from its saved value.' }
        }
        catch { $errors.Add("Audit restore $($audit.Id): $_") }
    } }
    foreach ($savedProfile in $State.ProfilesBefore) {
        try {
            Set-NetFirewallProfile -Name $savedProfile.Name -LogAllowed $savedProfile.LogAllowed -LogBlocked $savedProfile.LogBlocked -LogFileName $savedProfile.LogFileName -LogMaxSizeKilobytes $savedProfile.LogMaxSizeKilobytes
            $restored = Get-NetFirewallProfile -Name $savedProfile.Name
            if ([int]$restored.LogAllowed -ne [int]$savedProfile.LogAllowed -or
                [int]$restored.LogBlocked -ne [int]$savedProfile.LogBlocked -or
                $restored.LogFileName -ine $savedProfile.LogFileName -or
                $restored.LogMaxSizeKilobytes -ne $savedProfile.LogMaxSizeKilobytes) { throw 'Firewall logging readback differs from its saved value.' }
        } catch { $errors.Add("Firewall logging restore $($savedProfile.Name): $_") }
    }
    if (-not $FirewallOnly) {
        try { Restore-EvEJSSecurityLogMaximum $State }
        catch { $errors.Add("Security log capacity restore: $_") }
    }
    if ($errors.Count) { throw ($errors -join [Environment]::NewLine) }
}

if ($Mode -eq 'Begin') {
    Assert-CaptureAdministrator
    Initialize-CaptureNative
    if (Test-Path -LiteralPath $statePath) { throw 'This output directory already contains a capture. Use a new directory or End the existing capture.' }
    if (-not $ClientPath) { throw 'Supply the EveJS tq directory as -ClientPath.' }
    $ClientPath = (Resolve-Path -LiteralPath $ClientPath).Path
    $startIni = Get-Content -Raw -LiteralPath (Join-Path $ClientPath 'start.ini')
    if (-not (Test-EvEJSCaptureClientIdentity $startIni)) {
        throw 'The client start.ini must contain server = 127.0.0.1 and cryptoPack = Placebo. Refusing a live EVE install.'
    }
    $clientExe = (Resolve-Path -LiteralPath (Join-Path $ClientPath 'bin64/exefile.exe')).Path
    $crashExe = (Resolve-Path -LiteralPath (Join-Path $ClientPath 'bin64/eve_crashmon.exe')).Path
    $processes = @(Get-CimInstance Win32_Process)
    if (@($processes | Where-Object { $_.ExecutablePath -ieq $clientExe -or $_.ExecutablePath -ieq $crashExe }).Count) { throw 'Quit the EveJS client and its crash handler before Begin so the capture includes their entire lifetimes.' }
    $serverProcess = @($processes | Where-Object ProcessId -eq $ServerProcessId)
    if ($serverProcess.Count -ne 1 -or [IO.Path]::GetFileName($serverProcess[0].ExecutablePath) -ine 'node.exe') { throw 'Supply -ServerProcessId for the running EveJS node.exe process.' }
    $gameListeners = @(Get-NetTCPConnection -State Listen -LocalPort $ServerPort -ErrorAction SilentlyContinue | Where-Object OwningProcess -eq $ServerProcessId)
    if (-not $gameListeners.Count) { throw "The supplied node PID does not own the EveJS game listener on port $ServerPort. Supply the actual server PID and -ServerPort." }
    foreach ($address in $ServerAddress) {
        $parsed = $null
        if (-not [Net.IPAddress]::TryParse($address, [ref]$parsed)) { throw 'ServerAddress must contain numeric IP addresses; this tool never resolves hostnames.' }
    }
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
    $devicePaths = @()
    foreach ($drive in [IO.Directory]::GetLogicalDrives()) {
        $buffer = [Text.StringBuilder]::new(32768)
        $name = $drive.TrimEnd('\')
        if ([EvEJSOfflineCaptureNative]::QueryDosDevice($name, $buffer, $buffer.Capacity)) {
            $devicePaths += [pscustomobject]@{ Drive = $name; Device = $buffer.ToString().Split([char]0)[0] }
        }
    }
    $auditBefore = @()
    foreach ($id in @('0CCE9225-69AE-11D9-BED3-505054503030', '0CCE9226-69AE-11D9-BED3-505054503030')) {
        $auditBefore += [pscustomobject]@{ Id = $id; Bits = [EvEJSOfflineCaptureNative]::GetAudit([Guid]$id) }
    }
    $securityLogBefore = Get-EvEJSSecurityLogSettings
    $securityLogCaptureMaximum = [Math]::Max([long]$securityLogBefore.MaximumSizeInBytes, [long](512MB))
    $captureId = [Guid]::NewGuid().ToString('N')
    $profilesBefore = @(Get-NetFirewallProfile | Select-Object Name,LogAllowed,LogBlocked,LogFileName,LogMaxSizeKilobytes)
    $activeProfilesBefore = @(Get-EvEJSActiveFirewallProfiles)
    $profilesDuring = @(New-EvEJSFirewallCaptureLogPlan -Profiles $profilesBefore -CaptureId ([guid]$captureId))
    $state = [ordered]@{
        Version = 1; Status = 'starting'; StartUtc = [DateTime]::UtcNow.ToString('o'); EndUtc = $null
        ClientExe = $clientExe; CrashExe = $crashExe; ServerProcessId = $ServerProcessId
        ServerExe = $serverProcess[0].ExecutablePath; ServerCommandLine = $serverProcess[0].CommandLine; ServerPort = $ServerPort
        ServerAddress = $ServerAddress; DevicePaths = $devicePaths
        AuditBefore = $auditBefore
        ProfilesBefore = $profilesBefore; ProfilesDuring = $profilesDuring
        ActiveProfilesBefore = $activeProfilesBefore; ActiveProfilesAfter = @(); FirewallLogArtifacts = @()
        SecurityLogBefore = $securityLogBefore
        SecurityLogCaptureMaximumBytes = $securityLogCaptureMaximum
        SecurityStartRecord = (Get-WinEvent -LogName Security -MaxEvents 1).RecordId
        Sessions = @(
            @{ Name = "EvEJS-DNS-$captureId"; File = (Join-Path $OutputDirectory 'dns.etl'); Provider = '{1C95126E-7EEA-49A9-A3FE-A378B03DDB4D}'; Keywords = '0xffffffffffffffff' },
            @{ Name = "EvEJS-Process-$captureId"; File = (Join-Path $OutputDirectory 'process.etl'); Provider = '{22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716}'; Keywords = '0x50' }
        )
        ProcessesBefore = @($processes | ForEach-Object { [pscustomobject]@{
            ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; ExecutablePath = $_.ExecutablePath
            CreationUtc = $_.CreationDate.ToUniversalTime().ToString('o')
        } })
        RestoreError = $null; StopErrors = @()
    }
    Write-CaptureJson $statePath $state
    try {
        Set-EvEJSSecurityLogMaximum -MaximumSizeInBytes $securityLogCaptureMaximum
        foreach ($audit in $auditBefore) { [EvEJSOfflineCaptureNative]::SetAudit([Guid]$audit.Id, 3) }
        foreach ($profile in $profilesDuring) {
            Set-NetFirewallProfile -Name $profile.Name -LogAllowed True -LogBlocked True -LogFileName $profile.LogFileName -LogMaxSizeKilobytes $profile.LogMaxSizeKilobytes
        }
        Assert-EvEJSFirewallCaptureLogging $profilesDuring
        foreach ($session in $state.Sessions) {
            Invoke-CaptureCommand 'logman.exe' @('create','trace',$session.Name,'-o',$session.File,'-p',$session.Provider,$session.Keywords,'5','-bs','64','-nb','16','256','-max','512','-ets') | Out-Null
        }
        Clear-DnsClientCache
        $state.StartUtc = [DateTime]::UtcNow.ToString('o')
        $state.Status = 'recording'
        Write-CaptureJson $statePath $state
        Write-Output "Recording. Use Play.bat, login, select a character, undock, warp, dock and quit. Then run End with this same output directory: $OutputDirectory"
    } catch {
        $beginError = $_
        $stopErrors = @()
        foreach ($session in $state.Sessions) {
            try { Stop-CaptureSession $session.Name -StatisticsPath ($session.File + '.statistics.json') -AllowAbsent }
            catch { $stopErrors += [string]$_ }
        }
        $state.StopErrors = $stopErrors
        try { Restore-CaptureSettings $state } catch { $state.RestoreError = [string]$_ }
        $state.Status = 'begin-failed'
        Write-CaptureJson $statePath $state
        if ($state.RestoreError -or $stopErrors.Count) { Write-Warning 'Capture cleanup was incomplete. Run -Mode Restore with this output directory and inspect capture-state.json.' }
        throw $beginError
    }
    return
}

$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ($Mode -eq 'Restore') {
    Assert-CaptureAdministrator
    Initialize-CaptureNative
    $state.StopErrors = @()
    foreach ($session in $state.Sessions) {
        try { Stop-CaptureSession $session.Name -StatisticsPath ($session.File + '.statistics.json') -AllowAbsent }
        catch { $state.StopErrors += [string]$_ }
    }
    try { Restore-CaptureSettings $state; $state.RestoreError = $null }
    catch { $state.RestoreError = [string]$_ }
    if ($state.Status -eq 'recording') { $state.Status = 'restored-without-report' }
    Write-CaptureJson $statePath $state
    if ($state.RestoreError -or $state.StopErrors.Count) { throw 'Recovery is incomplete. Inspect RestoreError and StopErrors in capture-state.json and retry Restore.' }
    Write-Output 'Capture sessions stopped. Saved audit and firewall logging settings restored and read back successfully.'
    return
}
if ($Mode -eq 'End') {
    Assert-CaptureAdministrator
    Initialize-CaptureNative
    if ($state.Status -ne 'recording') { throw "Capture is not recording: $($state.Status). Review capture-state.json before recovery." }
    $state.EndUtc = [DateTime]::UtcNow.ToString('o')
    $captureErrors = [Collections.Generic.List[string]]::new()
    $state.StopErrors = @()
    try {
        foreach ($session in $state.Sessions) {
            try { Stop-CaptureSession $session.Name -StatisticsPath ($session.File + '.statistics.json') }
            catch { $captureErrors.Add([string]$_); $state.StopErrors += [string]$_ }
            try {
                $statistics = Get-Content -Raw -LiteralPath ($session.File + '.statistics.json') | ConvertFrom-Json
                foreach ($loss in @(Get-EvEJSTraceLossErrors $statistics)) { $captureErrors.Add("$($session.Name): $loss") }
            } catch { $captureErrors.Add("$($session.Name) counters: $_") }
        }
        $start = [DateTime]::Parse($state.StartUtc)
        $end = [DateTime]::Parse($state.EndUtc)
        $activeProfilesAfter = @()
        $freshLogs = $null -ne $state.PSObject.Properties['ProfilesDuring']
        if ($freshLogs) {
            try {
                Assert-EvEJSFirewallCaptureLogging $state.ProfilesDuring
                $activeProfilesAfter = @(Get-EvEJSActiveFirewallProfiles)
                $state.ActiveProfilesAfter = $activeProfilesAfter
                if (@(Compare-Object @($state.ActiveProfilesBefore) $activeProfilesAfter).Count) { $captureErrors.Add('Active firewall profiles changed during capture; review is incomplete.') }
            } catch { $captureErrors.Add("Firewall logging/profile readback failed: $_") }
            # Retire our sinks before slow trace decoding so unrelated traffic
            # cannot keep filling them. Keep audit and Security capacity intact
            # until WFP export. The finally block repeats full saved recovery.
            try { Restore-CaptureSettings $state -FirewallOnly }
            catch { $state.RestoreError = [string]$_; $captureErrors.Add("Capture sink finalization failed: $_") }
        }
        $logArtifacts = @()
        foreach ($logSource in @(Get-EvEJSFirewallCaptureLogSources -State $state -ActiveProfilesAfter $activeProfilesAfter)) {
            $logPath = $logSource.SourcePath
            $present = Test-Path -LiteralPath $logPath -PathType Leaf
            $logArtifacts += [pscustomobject]@{ Name=$logSource.Name; SourcePath=$logPath; Present=[bool]$present; Required=$logSource.Required }
            $copiedLogs = @()
            if ($present) {
                $copyPath = Join-Path $OutputDirectory ($logSource.Name + '-pfirewall.log')
                if ($freshLogs) { Copy-EvEJSClosedFirewallLog -Source $logPath -Destination $copyPath }
                else { Copy-Item -LiteralPath $logPath -Destination $copyPath }
                $copiedLogs += $copyPath
            }
            elseif ($logSource.Required) { $captureErrors.Add("Active firewall text log is missing: $logPath") }
            if (Test-Path -LiteralPath ($logPath + '.old')) {
                $copyPath = Join-Path $OutputDirectory ($logSource.Name + '-pfirewall.log.old')
                if ($freshLogs) { Copy-EvEJSClosedFirewallLog -Source ($logPath + '.old') -Destination $copyPath }
                else { Copy-Item -LiteralPath ($logPath + '.old') -Destination $copyPath }
                $copiedLogs += $copyPath
            }
            try {
                foreach ($logError in @(Get-EvEJSFirewallTextLogLossErrors -Path $copiedLogs -Start $start -End $end -CaptureOwned:$freshLogs)) { $captureErrors.Add($logError) }
            } catch { $captureErrors.Add("Firewall text log loss check failed: $_") }
        }
        $state | Add-Member -NotePropertyName FirewallLogArtifacts -NotePropertyValue $logArtifacts -Force
        $securityEvents = @()
        try { $securityEvents = @(Get-EvEJSCaptureSecurityEvents -Start $start -End $end) }
        catch { $captureErrors.Add("Security event read failed: $_") }
        if (@($securityEvents | Where-Object Id -eq 1102).Count) { $captureErrors.Add('Security log was cleared during capture; WFP evidence is incomplete.') }
        $wfp = @($securityEvents | Where-Object Id -in @(5152,5156,5157) | ForEach-Object { ConvertTo-EvEJSEventRecord $_ })
        Write-CaptureJson (Join-Path $OutputDirectory 'wfp.json') $wfp
        Write-CaptureJson (Join-Path $OutputDirectory 'dns-cache.json') @(Get-DnsClientCache)
        try {
            # A retained record range cannot detect audit transport loss. Include
            # delayed health notices through completed WFP export, not only End.
            $securityHealth = Get-EvEJSCaptureSecurityHealth -Start $start -Through ([datetime]::UtcNow)
            Write-CaptureJson (Join-Path $OutputDirectory 'security-health.json') $securityHealth
            foreach ($healthError in $securityHealth.Errors) { $captureErrors.Add($healthError) }
        } catch { $captureErrors.Add("Security audit health read/export failed: $_") }
        $oldest = (Get-WinEvent -LogName Security -Oldest -MaxEvents 1).RecordId
        $newest = (Get-WinEvent -LogName Security -MaxEvents 1).RecordId
        if ($null -eq $oldest -or $null -eq $newest -or [long]$oldest -le 0 -or [long]$newest -lt [long]$oldest) {
            throw 'Security log record bounds are unavailable or invalid.'
        }
        $state | Add-Member -NotePropertyName SecurityEndBounds -NotePropertyValue ([pscustomobject]@{
            OldestRecordId = [long]$oldest; NewestRecordId = [long]$newest; CheckedUtc = [datetime]::UtcNow.ToString('o')
        }) -Force
        if ($oldest -gt $state.SecurityStartRecord) { $captureErrors.Add('Security log rolled over during capture; WFP evidence may be incomplete.') }
        if ($newest -lt $state.SecurityStartRecord) { $captureErrors.Add('Security log record IDs reset during capture; WFP evidence is incomplete.') }
        $expectedMaximum = if ($null -ne $state.PSObject.Properties['SecurityLogCaptureMaximumBytes']) { [long]$state.SecurityLogCaptureMaximumBytes } else { 0L }
        try {
            foreach ($capacityError in @(Get-EvEJSSecurityLogCapacityErrors -ExpectedMaximumSizeInBytes $expectedMaximum)) { $captureErrors.Add($capacityError) }
        } catch { $captureErrors.Add("Security log capacity read failed: $_") }
        foreach ($session in $state.Sessions) {
            $stem = [IO.Path]::GetFileNameWithoutExtension($session.File)
            try {
                $records = @(Get-WinEvent -Path $session.File -Oldest | Where-Object { $_.ProviderName -in @('Microsoft-Windows-DNS-Client','Microsoft-Windows-Kernel-Process') } | ForEach-Object { ConvertTo-EvEJSEventRecord $_ })
                Write-CaptureJson (Join-Path $OutputDirectory ($stem + '-events.json')) $records
                Invoke-CaptureCommand 'tracerpt.exe' @($session.File,'-o',(Join-Path $OutputDirectory ($stem + '-events.xml')),'-of','XML','-summary',(Join-Path $OutputDirectory ($stem + '-summary.xml')),'-y') | Out-Null
            } catch { $captureErrors.Add("$stem trace: $_") }
        }

    } catch {
        $captureErrors.Add("Capture collection failed: $_")
    } finally {
        try { Restore-CaptureSettings $state } catch { $state.RestoreError = [string]$_; $captureErrors.Add([string]$_) }
        $state.Status = 'stopped'
        Write-CaptureJson $statePath $state
        Write-CaptureJson (Join-Path $OutputDirectory 'capture-errors.json') @($captureErrors)
    }
}

if ($state.Status -ne 'stopped') { throw 'End the capture before making a report.' }
$wfp = @(Read-EvEJSCaptureJsonArray (Join-Path $OutputDirectory 'wfp.json'))
$issues = [Collections.Generic.List[string]]::new()
$clientPaths = @($state.ClientExe,$state.CrashExe | ForEach-Object { ConvertTo-EvEJSApplicationPath $_ $state.DevicePaths })
$serverPath = ConvertTo-EvEJSApplicationPath $state.ServerExe $state.DevicePaths
$matchedWfpEvents = @()
foreach ($event in $wfp) {
    $application = ConvertTo-EvEJSApplicationPath ([string]$event.Data.Application) $state.DevicePaths
    $isClient = $application -in $clientPaths
    $isServer = $application -eq $serverPath -and [int64]$event.Data.ProcessId -eq [int64]$state.ServerProcessId
    if (-not $isClient -and -not $isServer) { continue }
    $matchedWfpEvents += $event
    # Windows event resource %%14593 is outbound; unknown direction is kept for review.
    if ($event.Data.Direction -notin @('%%14592','%%14593')) { $issues.Add('Unknown WFP direction; inspect wfp.json.') }
    if ($event.Data.Direction -eq '%%14593' -and -not (Test-EvEJSAllowedAddress $event.Data.DestAddress $state.ServerAddress)) {
        $issues.Add("$($event.Id) $application protocol=$($event.Data.Protocol) destination=$($event.Data.DestAddress):$($event.Data.DestPort)")
    }
}
$dnsEventsPath = Join-Path $OutputDirectory 'dns-events.json'
$forbiddenDns = @()
if (Test-Path -LiteralPath $dnsEventsPath) {
    $forbiddenDns = @(Read-EvEJSCaptureJsonArray $dnsEventsPath | Where-Object { $_.Data.PSObject.Properties['QueryName'] -and (Test-EvEJSForbiddenDnsName $_.Data.QueryName) })
}
$captureErrors = @()
try {
    $captureErrors = @(Read-EvEJSCaptureJsonArray (Join-Path $OutputDirectory 'capture-errors.json'))
    foreach ($captureError in $captureErrors) {
        if ($captureError -isnot [string] -or [string]::IsNullOrWhiteSpace($captureError)) { throw 'Capture error entries must be nonempty strings.' }
    }
}
catch { $captureErrors = @("Capture error record is unreadable: $_") }
$report = [ordered]@{
    Status = 'REVIEW_REQUIRED'; StartUtc = $state.StartUtc; EndUtc = $state.EndUtc
    MatchedWfpEvents = $matchedWfpEvents; ForbiddenDestinationEvents = @($issues)
    ForbiddenDnsEventsAllProcesses = $forbiddenDns
    Server = @{ ProcessId = $state.ServerProcessId; ExecutablePath = $state.ServerExe; CommandLine = $state.ServerCommandLine }
    RestoreError = $state.RestoreError
    StopErrors = $state.StopErrors
    CaptureErrors = $captureErrors
    RequiredReview = @(
        'Check capture-errors.json and both tracerpt summary files: any event loss or unreadable evidence fails the capture.',
        'Check security-health.json for audit transport loss, discarded audits, full logs and logging service failures; any listed event fails the capture.',
        'Correlate DNS ClientPID (or header PID) with process-events.json and ProcessesBefore by full path and lifetime; never identify a live EVE client by basename alone.',
        'Include server descendants using process parent IDs, and reject PID reuse or an unidentifiable process. The direct-server WFP list does not automatically attribute child workers.',
        'Confirm matching client and server activity was captured; an empty result is not proof.',
        'Check Kernel-Process image-load event 5 for TracyClient.dll in the EveJS client, and UDP protocol 17 in WFP.',
        'The firewall text log and DNS cache supplement WFP and ETW; neither independently proves process attribution.',
        'Record completion of login, character select, undock, warp, dock and quit. The script cannot observe gameplay.',
        'Repeat the capture for the owner-controlled firewall-disabled check; Play warns about the disabled rules and starts.'
    )
}
$report.Status = Get-EvEJSCaptureReportStatus -Issues @($issues) -CaptureErrors $captureErrors -RestoreError $state.RestoreError -StopErrors $state.StopErrors
Write-CaptureJson (Join-Path $OutputDirectory 'report.json') $report
Write-Output "$($report.Status): inspect report.json and raw evidence in $OutputDirectory."
if ($state.RestoreError) { Write-Warning "Settings restoration failed: $($state.RestoreError)" }
else { Write-Output 'Saved audit policy and firewall logging settings were restored and read back successfully.' }
if ($state.StopErrors.Count) { Write-Warning 'Trace cleanup is incomplete. Run -Mode Restore with this output directory before leaving the capture.' }
if ($report.Status -eq 'FAIL') { exit 1 }
exit 2 # Evidence needs review; an unreviewed capture is never an automatic pass.
