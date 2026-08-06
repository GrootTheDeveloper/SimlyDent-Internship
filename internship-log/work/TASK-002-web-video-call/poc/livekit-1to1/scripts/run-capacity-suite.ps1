<#
.SYNOPSIS
  Run API signaling load + media SFU load, write combined capacity report.

.EXAMPLE
  .\scripts\run-capacity-suite.ps1
  .\scripts\run-capacity-suite.ps1 -ApiLevels @(1,2,3,5) -MediaRooms @(1,2,3) -MediaDurationSeconds 40
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$LiveKitUrl = "ws://localhost:7880",
    # Comma-separated lists are -File-safe (avoid powershell -File array splitting)
    [string]$ApiLevels = "1,2,3,5,8",
    [int]$ApiHoldSeconds = 8,
    [string]$MediaRooms = "1,2,3,5",
    [int]$MediaDurationSeconds = 40,
    [string]$VideoResolution = "high",
    [string]$LiveKitCli,
    [switch]$SkipMedia,
    [switch]$SkipApi,
    [switch]$SkipDockerStats
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\poc-load-common.ps1")

$root = Get-PocRoot
$suiteDir = New-LoadReportDir -Root $root -Prefix "suite"
Write-Host "Capacity suite output: $suiteDir"

$apiExit = 0
$mediaExit = 0
$apiDir = $null
$mediaDir = $null

if (-not $SkipApi) {
    $apiDir = Join-Path $suiteDir "api"
    New-Item -ItemType Directory -Force -Path $apiDir | Out-Null
    Write-Host "`n######## API LOAD ########"
    $apiArgs = @{
        ApiUrl             = $ApiUrl
        ConcurrentLevels   = $ApiLevels
        HoldSeconds        = $ApiHoldSeconds
        OutDir             = $apiDir
    }
    if ($SkipDockerStats) { $apiArgs.SkipDockerStats = $true }
    try {
        & (Join-Path $PSScriptRoot "api-load-test.ps1") @apiArgs
        $apiExit = $LASTEXITCODE
    }
    catch {
        Write-Host "API load threw: $_"
        $apiExit = 99
    }
    if ($null -eq $apiExit) { $apiExit = 0 }
}

if (-not $SkipMedia) {
    $mediaDir = Join-Path $suiteDir "media"
    New-Item -ItemType Directory -Force -Path $mediaDir | Out-Null
    Write-Host "`n######## MEDIA LOAD ########"
    $mediaArgs = @{
        LiveKitUrl        = $LiveKitUrl
        ConcurrentRooms   = $MediaRooms
        DurationSeconds   = $MediaDurationSeconds
        VideoResolution   = $VideoResolution
        OutDir            = $mediaDir
    }
    if ($LiveKitCli) { $mediaArgs.LiveKitCli = $LiveKitCli }
    if ($SkipDockerStats) { $mediaArgs.SkipDockerStats = $true }
    try {
        & (Join-Path $PSScriptRoot "media-load-test.ps1") @mediaArgs
        $mediaExit = $LASTEXITCODE
    }
    catch {
        Write-Host "Media load threw: $_"
        $mediaExit = 99
    }
    if ($null -eq $mediaExit) { $mediaExit = 0 }
}

# Combined summary
$apiSummary = $null
$mediaSummary = $null
if ($apiDir -and (Test-Path (Join-Path $apiDir "api-load-report.json"))) {
    $apiSummary = Get-Content (Join-Path $apiDir "api-load-report.json") -Raw | ConvertFrom-Json
}
if ($mediaDir -and (Test-Path (Join-Path $mediaDir "media-load-report.json"))) {
    $mediaSummary = Get-Content (Join-Path $mediaDir "media-load-report.json") -Raw | ConvertFrom-Json
}

$hostInfo = [ordered]@{
    machine       = $env:COMPUTERNAME
    os            = [Environment]::OSVersion.VersionString
    atUtc         = [DateTimeOffset]::UtcNow.ToString("o")
    note          = "Local Docker Desktop host unless run on VPS. VPS GOLD4 = 2 vCPU / 4 GB — re-run suite there for production-ish numbers."
}

$combined = [ordered]@{
    host              = $hostInfo
    apiExitCode       = $apiExit
    mediaExitCode     = $mediaExit
    apiMaxFullPairs   = if ($apiSummary) { $apiSummary.maxFullSuccessPairs } else { $null }
    mediaMaxFullRooms = if ($mediaSummary) { $mediaSummary.maxFullSuccessRooms } else { $null }
    apiBusyRulePass   = if ($apiSummary) { $apiSummary.busyRulePass } else { $null }
    apiReport         = $apiSummary
    mediaReport       = $mediaSummary
}
Write-JsonFile -Object $combined -Path (Join-Path $suiteDir "combined-report.json")

$md = @()
$md += "# Capacity suite combined report"
$md += ""
$md += "- Host: $($hostInfo.machine) · $($hostInfo.os)"
$md += "- UTC: $($hostInfo.atUtc)"
$md += "- $($hostInfo.note)"
$md += ""
$md += "## API / signaling"
if ($apiSummary) {
    $md += "- Busy rule: **$(if ($apiSummary.busyRulePass) { 'PASS' } else { 'FAIL' })**"
    $md += "- Max concurrent pairs @ 100% success: **$($apiSummary.maxFullSuccessPairs)**"
    $md += "- Exit code: $apiExit"
    $md += "- Details: [api/SUMMARY.md](api/SUMMARY.md)"
}
else { $md += "- Skipped or failed to produce report." }
$md += ""
$md += "## Media SFU (CLI publishers)"
if ($mediaSummary) {
    $md += "- Max concurrent rooms (2 pubs each) @ 100% process success: **$($mediaSummary.maxFullSuccessRooms)**"
    $md += "- Duration/level: $($mediaSummary.durationSeconds)s · res $($mediaSummary.videoResolution)"
    $md += "- Exit code: $mediaExit"
    $md += "- Details: [media/SUMMARY.md](media/SUMMARY.md)"
}
else { $md += "- Skipped or failed to produce report." }
$md += ""
$md += "## How to read"
$md += "- **API pairs** = app JWT call lifecycle concurrent capacity (business path)."
$md += "- **Media rooms** = LiveKit SFU forwarding load with synthetic video (not browser encode)."
$md += "- Numbers on a laptop Docker host are **not** VPS GOLD4 numbers — re-run on VPS for deploy capacity."
$md -join "`n" | Set-Content -LiteralPath (Join-Path $suiteDir "SUMMARY.md") -Encoding UTF8

Write-Host "`n======== SUITE DONE ========"
Write-Host "Report: $suiteDir\SUMMARY.md"
Write-Host "API exit=$apiExit Media exit=$mediaExit"
if ($apiExit -ne 0 -or $mediaExit -ne 0) { exit 1 }
exit 0
