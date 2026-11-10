param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2147483647)]
    [int]$ServerProcessId,
    [Parameter(Mandatory = $true)]
    [string]$OutputPath,
    [ValidateRange(1, 3600)]
    [int]$Seconds = 900,
    [string]$StopFile = ''
)

# Read-only Windows counters in a separate process, so samples continue while
# the Node event loop is blocked. CIM class/property names are not localized.
$ErrorActionPreference = 'Stop'
$targetProcess = Get-Process -Id $ServerProcessId -ErrorAction Stop
$targetStartUtc = $targetProcess.StartTime.ToUniversalTime().ToString('o')
$absoluteOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
[System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($absoluteOutputPath)) | Out-Null
$outputStream = [System.IO.File]::Open($absoluteOutputPath, [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
$writer = [System.IO.StreamWriter]::new($outputStream, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$captureClock = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $writer.WriteLine((@{
        type = 'start'; utc = [DateTime]::UtcNow.ToString('o'); pid = $ServerProcessId
        processStartUtc = $targetStartUtc; durationSeconds = $Seconds
        note = 'Process faults include soft faults; memory page-in counters are system-wide, not proof of per-process hard faults.'
    } | ConvertTo-Json -Compress))
    Write-Host "Capturing PID $ServerProcessId for up to $Seconds seconds: $absoluteOutputPath"
    while ($captureClock.Elapsed.TotalSeconds -lt $Seconds) {
        if ($StopFile -and (Test-Path -LiteralPath $StopFile)) { break }
        $targetProcess.Refresh()
        if ($targetProcess.HasExited) { break }
        $queryStartMs = $captureClock.Elapsed.TotalMilliseconds
        $processCounters = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfProc_Process `
            -Filter "IDProcess = $ServerProcessId" -ErrorAction Stop
        if ($null -eq $processCounters) { break }
        $memoryCounters = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Memory -ErrorAction Stop
        $writer.WriteLine((@{
            type = 'sample'; utc = [DateTime]::UtcNow.ToString('o'); pid = $ServerProcessId
            elapsedMs = $captureClock.Elapsed.TotalMilliseconds
            queryMs = $captureClock.Elapsed.TotalMilliseconds - $queryStartMs
            process = @{
                cpuPercentOfOneCore = $processCounters.PercentProcessorTime
                workingSetBytes = $processCounters.WorkingSet
                privateBytes = $processCounters.PrivateBytes
                pageFaultsPerSec = $processCounters.PageFaultsPersec
                ioReadBytesPerSec = $processCounters.IOReadBytesPersec
                ioWriteBytesPerSec = $processCounters.IOWriteBytesPersec
            }
            systemMemory = @{
                availableMBytes = $memoryCounters.AvailableMBytes
                pagesInputPerSec = $memoryCounters.PagesInputPersec
                pageReadsPerSec = $memoryCounters.PageReadsPersec
                pagesOutputPerSec = $memoryCounters.PagesOutputPersec
            }
        } | ConvertTo-Json -Depth 4 -Compress))
        $remainingMs = $Seconds * 1000 - $captureClock.Elapsed.TotalMilliseconds
        if ($remainingMs -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(1000, $remainingMs)) }
    }
    $writer.WriteLine((@{ type = 'stop'; utc = [DateTime]::UtcNow.ToString('o')
        elapsedMs = $captureClock.Elapsed.TotalMilliseconds } | ConvertTo-Json -Compress))
} catch {
    $writer.WriteLine((@{ type = 'error'; utc = [DateTime]::UtcNow.ToString('o')
        message = $_.Exception.Message } | ConvertTo-Json -Compress))
    throw
} finally {
    $writer.Dispose()
    $targetProcess.Dispose()
}
