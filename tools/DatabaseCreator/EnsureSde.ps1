param(
    [Parameter(Mandatory = $true)][string]$SdeUrl,
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$ExtractPath,
    [Parameter(Mandatory = $true)][int]$Build
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$expectedName = "eve-online-static-data-$Build-jsonl"
if ([IO.Path]::GetFileName($ArchivePath) -ne "$expectedName.zip" -or
    [IO.Path]::GetFileName($ExtractPath) -ne $expectedName) {
    throw 'SDE cache paths do not match the requested build.'
}

$ArchivePath = [IO.Path]::GetFullPath($ArchivePath)
$ExtractPath = [IO.Path]::GetFullPath($ExtractPath)
$archivePartial = "$ArchivePath.partial"
$extractPartial = "$ExtractPath.partial"
$markerName = '.evejs-sde-complete'
$requiredFiles = @(
    '_sde.jsonl',
    'agentTypes.jsonl',
    'bloodlines.jsonl',
    'blueprints.jsonl',
    'categories.jsonl',
    'dbuffCollections.jsonl',
    'dogmaAttributes.jsonl',
    'dogmaEffects.jsonl',
    'dynamicItemAttributes.jsonl',
    'factions.jsonl',
    'groups.jsonl',
    'icons.jsonl',
    'mapAsteroidBelts.jsonl',
    'mapConstellations.jsonl',
    'mapMoons.jsonl',
    'mapPlanets.jsonl',
    'mapRegions.jsonl',
    'mapSolarSystems.jsonl',
    'mapStargates.jsonl',
    'mapStars.jsonl',
    'npcCharacters.jsonl',
    'npcCorporations.jsonl',
    'npcStations.jsonl',
    'planetResources.jsonl',
    'planetSchematics.jsonl',
    'races.jsonl',
    'skinLicenses.jsonl',
    'skinMaterials.jsonl',
    'skins.jsonl',
    'sovereigntyUpgrades.jsonl',
    'stationOperations.jsonl',
    'typeDogma.jsonl',
    'typeLists.jsonl',
    'typeMaterials.jsonl',
    'types.jsonl'
)

function Remove-GeneratedPath([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Assert-SdeBuild([System.IO.Stream]$Stream) {
    $reader = New-Object System.IO.StreamReader($Stream)
    try {
        while (($line = $reader.ReadLine()) -ne $null) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $record = ConvertFrom-Json -InputObject $line
            if ($record._key -eq 'sde') {
                if ([int]$record.buildNumber -ne $Build) {
                    throw "Expected SDE build $Build, found $($record.buildNumber)."
                }
                return
            }
        }
        throw 'SDE metadata record is missing.'
    }
    finally {
        $reader.Dispose()
    }
}

function Assert-SdeArchive([string]$Path) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        foreach ($name in $requiredFiles) {
            $entry = $archive.GetEntry($name)
            if ($null -eq $entry -or $entry.Length -eq 0) {
                throw "SDE ZIP is missing $name."
            }
        }
        Assert-SdeBuild ($archive.GetEntry('_sde.jsonl').Open())
    }
    finally {
        $archive.Dispose()
    }
}

function Assert-SdeFiles([string]$Path) {
    foreach ($name in $requiredFiles) {
        $file = Join-Path $Path $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or
            (Get-Item -LiteralPath $file).Length -eq 0) {
            throw "Extracted SDE is missing $name."
        }
    }
    Assert-SdeBuild ([IO.File]::OpenRead((Join-Path $Path '_sde.jsonl')))
}

function Test-CompleteExtraction {
    $marker = Join-Path $ExtractPath $markerName
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return $false }
    try {
        if ((Get-Content -LiteralPath $marker -Raw).Trim() -ne [string]$Build) {
            return $false
        }
        Assert-SdeFiles $ExtractPath
        return $true
    }
    catch {
        Write-Host "  Ignoring incomplete extracted SDE: $($_.Exception.Message)"
        return $false
    }
}

New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($ArchivePath)) -Force | Out-Null
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($ExtractPath)) -Force | Out-Null
Remove-GeneratedPath $archivePartial
Remove-GeneratedPath $extractPartial

if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
    try {
        Assert-SdeArchive $ArchivePath
        Write-Host '  Using cached SDE zip.'
    }
    catch {
        Write-Host "  Discarding invalid cached SDE zip: $($_.Exception.Message)"
        Remove-GeneratedPath $ArchivePath
    }
}

if (Test-CompleteExtraction) {
    Write-Host '  Using extracted SDE directory.'
    exit 0
}

for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
        if (-not (Test-Path -LiteralPath $ArchivePath -PathType Leaf)) {
            Write-Host '  Downloading CCP public SDE JSONL...'
            Invoke-WebRequest -Uri $SdeUrl -OutFile $archivePartial -UseBasicParsing
            Assert-SdeArchive $archivePartial
            Move-Item -LiteralPath $archivePartial -Destination $ArchivePath
        }

        Write-Host '  Extracting SDE zip...'
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $extractPartial -Force
        Assert-SdeFiles $extractPartial
        [IO.File]::WriteAllText((Join-Path $extractPartial $markerName), "$Build`n")
        Remove-GeneratedPath $ExtractPath
        Move-Item -LiteralPath $extractPartial -Destination $ExtractPath
        exit 0
    }
    catch {
        $failure = $_.Exception.Message
        Remove-GeneratedPath $archivePartial
        Remove-GeneratedPath $extractPartial
        Remove-GeneratedPath $ArchivePath
        if ($attempt -eq 2) {
            throw "Could not prepare SDE build $Build after retry: $failure"
        }
        Write-Host "  SDE preparation failed: $failure"
        Write-Host '  Retrying with a fresh download...'
    }
}
