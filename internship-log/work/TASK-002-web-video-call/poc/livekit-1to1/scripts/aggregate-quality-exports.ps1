<#
.SYNOPSIS
  Aggregate multiple quality CSV exports (from real 2-device calls) into min/p50/avg/max.

.EXAMPLE
  .\scripts\aggregate-quality-exports.ps1 -InputDir .\evidence\perf-real\exports
#>
param(
    [Parameter(Mandatory = $true)][string]$InputDir,
    [string]$OutFile
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path -LiteralPath $InputDir)) {
    throw "InputDir not found: $InputDir"
}

$csvs = Get-ChildItem -Path $InputDir -Recurse -Filter "*quality.csv" -File -ErrorAction SilentlyContinue
if (-not $csvs -or $csvs.Count -eq 0) {
    throw "No *quality.csv under $InputDir"
}

function Percentile([double[]]$sorted, [double]$p) {
    if ($sorted.Count -eq 0) { return $null }
    $idx = [int][Math]::Floor(($sorted.Count - 1) * $p)
    return $sorted[$idx]
}

function Agg([double[]]$vals) {
    if (-not $vals -or $vals.Count -eq 0) {
        return [PSCustomObject]@{ n = 0; min = $null; p50 = $null; avg = $null; max = $null }
    }
    $s = $vals | Sort-Object
    $avg = ($s | Measure-Object -Average).Average
    return [PSCustomObject]@{
        n   = $s.Count
        min = [Math]::Round($s[0], 2)
        p50 = [Math]::Round((Percentile $s 0.5), 2)
        avg = [Math]::Round($avg, 2)
        max = [Math]::Round($s[-1], 2)
    }
}

$perFile = @()
$allInBr = New-Object System.Collections.Generic.List[double]
$allOutBr = New-Object System.Collections.Generic.List[double]
$allLoss = New-Object System.Collections.Generic.List[double]
$allRtt = New-Object System.Collections.Generic.List[double]
$allFpsIn = New-Object System.Collections.Generic.List[double]

foreach ($csv in $csvs) {
    $rows = Import-Csv -LiteralPath $csv.FullName
    if (-not $rows) { continue }

    # Column names depend on CallQualityStore.ToCsv — match flexibly
    $inBr = @()
    $outBr = @()
    $loss = @()
    $rtt = @()
    $fpsIn = @()

    foreach ($row in $rows) {
        $props = $row.PSObject.Properties.Name
        $parseNum = {
            param($name)
            if ($props -notcontains $name) { return $null }
            $raw = $row.$name
            if ($null -eq $raw -or "$raw" -eq "" -or "$raw" -eq "null") { return $null }
            $d = 0.0
            if ([double]::TryParse("$raw", [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$d)) {
                return $d
            }
            return $null
        }

        # LiveKit PoC CSV: direction=incoming|outgoing, bitrateKbps, packetLossPercent, rttMs, fps
        $dir = if ($props -contains "direction") { "$($row.direction)".ToLowerInvariant() } else { "" }
        $br = & $parseNum "bitrateKbps"
        $pl = & $parseNum "packetLossPercent"
        $rt = & $parseNum "rttMs"
        $fp = & $parseNum "fps"

        if ($dir -eq "incoming") {
            if ($null -ne $br) { $inBr += $br; $allInBr.Add($br) }
            if ($null -ne $pl) { $loss += $pl; $allLoss.Add($pl) }
            if ($null -ne $fp) { $fpsIn += $fp; $allFpsIn.Add($fp) }
        }
        elseif ($dir -eq "outgoing") {
            if ($null -ne $br) { $outBr += $br; $allOutBr.Add($br) }
            if ($null -ne $rt) { $rtt += $rt; $allRtt.Add($rt) }
        }
        else {
            # Fallback wide-row formats
            $v = & $parseNum "incomingBitrateKbps"
            if ($null -ne $v) { $inBr += $v; $allInBr.Add($v) }
            $v = & $parseNum "outgoingBitrateKbps"
            if ($null -ne $v) { $outBr += $v; $allOutBr.Add($v) }
        }
    }

    $perFile += [PSCustomObject]@{
        file           = $csv.FullName
        rows           = $rows.Count
        incomingKbps   = Agg $inBr
        outgoingKbps   = Agg $outBr
        packetLossPct  = Agg $loss
        rttMs          = Agg $rtt
        incomingFps    = Agg $fpsIn
    }
}

$overall = [ordered]@{
    kind           = "quality-export-aggregate"
    inputDir       = (Resolve-Path $InputDir).Path
    fileCount      = $csvs.Count
    generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    overall        = [ordered]@{
        incomingKbps  = Agg $allInBr.ToArray()
        outgoingKbps  = Agg $allOutBr.ToArray()
        packetLossPct = Agg $allLoss.ToArray()
        rttMs         = Agg $allRtt.ToArray()
        incomingFps   = Agg $allFpsIn.ToArray()
    }
    perFile        = $perFile
}

if (-not $OutFile) {
    $OutFile = Join-Path $InputDir "AGGREGATE-quality.json"
}
$overall | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutFile -Encoding UTF8

$mdPath = [IO.Path]::ChangeExtension($OutFile, ".md")
$o = $overall.overall
$md = @()
$md += "# Quality export aggregate"
$md += ""
$md += "- Files: **$($csvs.Count)** under ``$InputDir``"
$md += "- Generated: $($overall.generatedAtUtc)"
$md += ""
$md += "| Metric | n | min | p50 | avg | max |"
$md += "|---|---:|---:|---:|---:|---:|"
foreach ($name in @("incomingKbps", "outgoingKbps", "packetLossPct", "rttMs", "incomingFps")) {
    $a = $o.$name
    $md += "| $name | $($a.n) | $($a.min) | $($a.p50) | $($a.avg) | $($a.max) |"
}
$md += ""
$md += "JSON: ``$OutFile``"
$md -join "`n" | Set-Content -LiteralPath $mdPath -Encoding UTF8

Write-Host "Wrote $OutFile"
Write-Host "Wrote $mdPath"
$overall.overall | Format-List
exit 0
