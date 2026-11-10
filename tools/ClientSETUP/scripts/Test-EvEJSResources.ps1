[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$ClientPath,
    [string]$ResFilesPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    $clientRoot = [IO.Path]::GetFullPath($ClientPath)
    if (-not $ResFilesPath) { $ResFilesPath = Join-Path $clientRoot '..\ResFiles' }
    $resourceRoot = [IO.Path]::GetFullPath($ResFilesPath).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not [IO.Directory]::Exists($resourceRoot)) { throw "ResFiles folder is missing: $resourceRoot" }
    $checked = 0
    $missing = 0
    foreach ($indexName in @('resfileindex.txt', 'resfileindex_Windows.txt')) {
        $indexPath = Join-Path $clientRoot $indexName
        if (-not [IO.File]::Exists($indexPath)) { throw "Required resource index is missing: $indexPath" }
        $indexCount = 0
        foreach ($line in [IO.File]::ReadLines($indexPath)) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $fields = $line.Split(',')
            if ($fields.Count -ne 5 -or $fields[0] -notmatch '^res:/' -or
                $fields[1] -notmatch '^[0-9a-fA-F]{2}/[0-9a-fA-F]+_[0-9a-fA-F]+$') {
                throw "Malformed resource index entry in ${indexPath}: $line"
            }
            $resourcePath = [IO.Path]::GetFullPath((Join-Path $resourceRoot $fields[1]))
            if (-not $resourcePath.StartsWith($resourceRoot, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Resource path escapes ResFiles: $resourcePath"
            }
            if (-not [IO.File]::Exists($resourcePath)) {
                $missing++
                if ($missing -le 10) { Write-Host "Missing resource: $resourcePath ($($fields[0]))" }
            }
            $indexCount++
            $checked++
        }
        if ($indexCount -eq 0) { throw "Resource index is empty: $indexPath" }
    }
    if ($missing -gt 0) {
        throw "$missing of $checked indexed resources are missing. Copy the missing ResFiles from your complete offline client backup; no download is permitted during play."
    }
    Write-Host "Resource gate passed: all $checked indexed entries exist under $resourceRoot"
    exit 0
} catch {
    Write-Host "[Resource gate] $($_.Exception.Message)"
    exit 1
}
