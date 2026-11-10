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
    # Keep launch validation constant-time: do not read indexes or enumerate cached files.
    foreach ($indexName in @('resfileindex.txt', 'resfileindex_Windows.txt')) {
        $indexPath = Join-Path $clientRoot $indexName
        if (-not [IO.File]::Exists($indexPath)) { throw "Required resource index is missing: $indexPath" }
        if (([IO.FileInfo]::new($indexPath)).Length -eq 0) { throw "Resource index is empty: $indexPath" }
    }
    Write-Host "Resource gate passed: ResFiles folder and both resource indexes are present (quick check)."
    exit 0
} catch {
    Write-Host "[Resource gate] $($_.Exception.Message)"
    exit 1
}
