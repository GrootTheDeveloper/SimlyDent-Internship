<#
.SYNOPSIS
  Run media-load-test.ps1 N times and aggregate Mbps / CPU / success (for stats, not single-shot).

.EXAMPLE
  .\scripts\run-repeated-media-load.ps1 -Repetitions 4 -ConcurrentRooms "1,3,5" -DurationSeconds 25
#>
param(
    [int]$Repetitions = 4,
    [string]$LiveKitUrl = "ws://localhost:7880",
    [string]$LiveKitCli,
    [string]$ConcurrentRooms = "1,3,5",
    [int]$DurationSeconds = 25,
    [ValidateSet("high", "medium", "low")][string]$VideoResolution = "high",
    [int]$SubscribersPerRoom = 2,
    [string]$MetricsUrl = "http://localhost:6789/metrics",
    [string]$OutDir,
    [switch]$SkipDockerStats
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\poc-load-common.ps1")

if ($Repetitions -lt 1) { throw "Repetitions must be >= 1" }
if ($Repetitions -gt 20) { throw "Repetitions cap is 20 for a single batch" }

$root = Get-PocRoot
if (-not $OutDir) { $OutDir = New-LoadReportDir -Root $root -Prefix "media-repeated" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Repeated media load: N=$Repetitions → $OutDir"

$runReports = @()
$exitCodes = @()

for ($i = 1; $i -le $Repetitions; $i++) {
    $runDir = Join-Path $OutDir ("run-{0:D2}" -f $i)
    New-Item -ItemType Directory -Force -Path $runDir | Out-Null
    Write-Host "`n################ REPEAT $i / $Repetitions ################"
    $args = @{
        LiveKitUrl         = $LiveKitUrl
        ConcurrentRooms    = $ConcurrentRooms
        DurationSeconds    = $DurationSeconds
        VideoResolution    = $VideoResolution
        SubscribersPerRoom = $SubscribersPerRoom
        MetricsUrl         = $MetricsUrl
        OutDir             = $runDir
    }
    if ($LiveKitCli) { $args.LiveKitCli = $LiveKitCli }
    if ($SkipDockerStats) { $args.SkipDockerStats = $true }

    try {
        & (Join-Path $PSScriptRoot "media-load-test.ps1") @args
        $code = $LASTEXITCODE
    }
    catch {
        Write-Host "Run $i threw: $_"
        $code = 99
    }
    if ($null -eq $code) { $code = 0 }
    $exitCodes += $code

    $reportPath = Join-Path $runDir "media-load-report.json"
    if (Test-Path $reportPath) {
        $rep = Get-Content $reportPath -Raw | ConvertFrom-Json
        $runReports += [PSCustomObject]@{
            runIndex = $i
            exitCode = $code
            report   = $rep
        }
    }
    else {
        $runReports += [PSCustomObject]@{ runIndex = $i; exitCode = $code; report = $null }
    }

    if ($i -lt $Repetitions) {
        Write-Host "Cool-down 5s before next repeat..."
        Start-Sleep -Seconds 5
    }
}

# Aggregate by concurrent room count
$byRooms = @{}
foreach ($rr in $runReports) {
    if (-not $rr.report -or -not $rr.report.levels) { continue }
    foreach ($lv in $rr.report.levels) {
        $k = [string]$lv.concurrentRooms
        if (-not $byRooms.ContainsKey($k)) { $byRooms[$k] = @() }
        $byRooms[$k] += [PSCustomObject]@{
            run              = $rr.runIndex
            successRate      = $lv.successRatePercent
            mbpsIn           = $lv.mbpsIn
            mbpsOut          = $lv.mbpsOut
            mbpsTotal        = $lv.mbpsTotal
            mbpsInMid        = $lv.mbpsInMid
            mbpsOutMid       = $lv.mbpsOutMid
            lossAvgPercent   = $lv.lossAvgPercent
            livekitCpuPeak   = $lv.livekitCpuPeakSeen
            packetsInPerSec  = $lv.packetsInPerSec
        }
    }
}

function Agg-Nums {
    param([object[]]$Values)
    $nums = @($Values | Where-Object { $null -ne $_ -and "$_" -ne "" } | ForEach-Object { [double]$_ })
    if ($nums.Count -eq 0) {
        return [PSCustomObject]@{ n = 0; min = $null; max = $null; avg = $null; p50 = $null }
    }
    $sorted = $nums | Sort-Object
    $avg = ($sorted | Measure-Object -Average).Average
    $p50 = $sorted[[int][Math]::Floor(($sorted.Count - 1) * 0.5)]
    return [PSCustomObject]@{
        n   = $sorted.Count
        min = [Math]::Round($sorted[0], 3)
        max = [Math]::Round($sorted[-1], 3)
        avg = [Math]::Round($avg, 3)
        p50 = [Math]::Round($p50, 3)
    }
}

$aggRows = @()
foreach ($k in ($byRooms.Keys | Sort-Object { [int]$_ })) {
    $rows = $byRooms[$k]
    $midTotals = @()
    foreach ($r in $rows) {
        if ($null -ne $r.mbpsInMid -and $null -ne $r.mbpsOutMid) {
            $midTotals += ([double]$r.mbpsInMid + [double]$r.mbpsOutMid)
        }
    }
    $aggRows += [PSCustomObject]@{
        concurrentRooms     = [int]$k
        repeats             = $rows.Count
        successRate         = Agg-Nums ($rows | ForEach-Object { $_.successRate })
        mbpsTotal           = Agg-Nums ($rows | ForEach-Object { $_.mbpsTotal })
        mbpsTotalMid        = Agg-Nums $midTotals
        mbpsIn              = Agg-Nums ($rows | ForEach-Object { $_.mbpsIn })
        mbpsOut             = Agg-Nums ($rows | ForEach-Object { $_.mbpsOut })
        lossAvgPercent      = Agg-Nums ($rows | ForEach-Object { $_.lossAvgPercent })
        livekitCpuPeak      = Agg-Nums ($rows | ForEach-Object { $_.livekitCpuPeak })
        rawRuns             = $rows
    }
}

$combined = [ordered]@{
    kind            = "media-load-repeated"
    repetitions     = $Repetitions
    concurrentRooms = $ConcurrentRooms
    durationSeconds = $DurationSeconds
    subscribers     = $SubscribersPerRoom
    exitCodes       = $exitCodes
    allRunsOk       = -not ($exitCodes | Where-Object { $_ -ne 0 })
    aggregates      = $aggRows
    runs            = $runReports | ForEach-Object {
        [PSCustomObject]@{ runIndex = $_.runIndex; exitCode = $_.exitCode; hasReport = ($null -ne $_.report) }
    }
}
Write-JsonFile -Object $combined -Path (Join-Path $OutDir "aggregate-report.json")

$md = @()
$md += "# Repeated media load (N=$Repetitions)"
$md += ""
$md += "- Rooms ladder: ``$ConcurrentRooms`` · duration ${DurationSeconds}s · subs/room=$SubscribersPerRoom"
$md += "- Exit codes: $($exitCodes -join ', ')"
$md += "- All runs exit 0: **$(if ($combined.allRunsOk) { 'yes' } else { 'no' })**"
$md += ""
$md += "## Aggregates (min / p50 / avg / max across repeats)"
$md += ""
$md += "| Rooms | # | success avg% | Mbps total p50 | Mbps total avg | Mid total p50 | loss% avg | CPU peak p50 |"
$md += "|---:|---:|---:|---:|---:|---:|---:|---:|"
foreach ($a in $aggRows) {
    $md += ("| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} |" -f `
        $a.concurrentRooms, $a.repeats, $a.successRate.avg, `
        $a.mbpsTotal.p50, $a.mbpsTotal.avg, $a.mbpsTotalMid.p50, `
        $a.lossAvgPercent.avg, $a.livekitCpuPeak.p50)
}
$md += ""
$md += "Per-run folders: ``run-01/`` … ``run-NN/``. Full JSON: ``aggregate-report.json``."
$md += ""
$md += "> Single run is a **sample**. Use p50/avg over 3–4 repeats for PoC claims; do not treat min of one run as capacity."
$md -join "`n" | Set-Content -LiteralPath (Join-Path $OutDir "SUMMARY.md") -Encoding UTF8

Write-Host "`nWrote $OutDir\SUMMARY.md"
if (-not $combined.allRunsOk) { exit 1 }
exit 0
