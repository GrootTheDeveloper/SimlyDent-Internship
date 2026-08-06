<#
.SYNOPSIS
  Media SFU load ladder using LiveKit CLI (simulated 1:1 rooms).

.DESCRIPTION
  For each concurrency level N, starts N rooms with 2 video publishers each
  (lk load-test), holds for Duration, samples docker stats + LiveKit Prometheus
  (bitrate Mbps in/out, packet rates, loss histogram avg, rooms/participants).

.EXAMPLE
  .\scripts\media-load-test.ps1 -ConcurrentRooms "1,2,3" -DurationSeconds 45
#>
param(
    [string]$LiveKitUrl = "ws://localhost:7880",
    [string]$LiveKitCli,
    [string]$ConcurrentRooms = "1,2,3,5",
    [int]$DurationSeconds = 45,
    [ValidateSet("high", "medium", "low")][string]$VideoResolution = "high",
    # Subscribers force SFU forward path (outgoing Mbps). 0 = publish-only (in only).
    [int]$SubscribersPerRoom = 2,
    [string]$MetricsUrl = "http://localhost:6789/metrics",
    [string]$OutDir,
    [switch]$SkipDockerStats,
    [switch]$SkipPrometheus
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\poc-load-common.ps1")

function Parse-IntList([string]$Text, [int[]]$Fallback) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Fallback }
    $parts = @($Text -split '[,;\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
    if ($parts.Count -eq 0) { return $Fallback }
    return $parts
}
$roomLevels = Parse-IntList $ConcurrentRooms @(1, 2, 3, 5)

$root = Get-PocRoot
$envMap = Read-PocEnv -Root $root
$apiKey = $envMap["LIVEKIT_API_KEY"]
if (-not $apiKey) { $apiKey = "devkey" }
$apiSecret = $envMap["LIVEKIT_API_SECRET"]
if ([string]::IsNullOrWhiteSpace($apiSecret)) {
    throw "LIVEKIT_API_SECRET missing in .env — run scripts/start.ps1 first."
}

$lk = Resolve-LiveKitCli -Explicit $LiveKitCli
if (-not $lk) {
    throw "LiveKit CLI (lk) not found. Install or pass -LiveKitCli."
}

$httpUrl = $LiveKitUrl -replace '^ws:', 'http:' -replace '^wss:', 'https:'

if (-not $OutDir) { $OutDir = New-LoadReportDir -Root $root -Prefix "media-load" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Media load report dir: $OutDir"
Write-Host "LiveKit=$httpUrl lk=$lk duration=${DurationSeconds}s rooms=$($roomLevels -join ',') pubs=2 subs=$SubscribersPerRoom"
Write-Host "Prometheus=$MetricsUrl (skip=$SkipPrometheus)"

$statsFile = Join-Path $OutDir "docker-stats.tsv"
$promFile = Join-Path $OutDir "livekit-metrics.tsv"
if (-not $SkipDockerStats) {
    Set-Content -LiteralPath $statsFile -Value "timestamp|name|cpu|memUsage|memPct" -Encoding UTF8
}

# Probe Prometheus once up front
$promProbe = $null
if (-not $SkipPrometheus) {
    $promProbe = Get-PrometheusMetricSamples -MetricsUrl $MetricsUrl
    if (-not $promProbe.ok) {
        Write-Host "WARN: Prometheus scrape failed ($($promProbe.error)). Bitrate/loss columns will be empty."
        Write-Host "  Ensure livekit.yaml has prometheus_port: 6789 and port 6789 is published."
    }
    else {
        Write-Host "Prometheus OK (rooms=$($promProbe.rooms) participants=$($promProbe.participants))"
        Append-LivekitMetricsTsv -File $promFile -Sample $promProbe
    }
}

function Append-DockerStatsSample {
    param([string]$File)
    if ($SkipDockerStats) { return }
    try {
        $lines = & docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>$null
        $ts = [DateTimeOffset]::UtcNow.ToString("o")
        $buf = New-Object System.Text.StringBuilder
        foreach ($line in $lines) {
            if ($line) { [void]$buf.AppendLine("$ts|$line") }
        }
        if ($buf.Length -gt 0) {
            [System.IO.File]::AppendAllText($File, $buf.ToString())
        }
    }
    catch { }
}

function Get-PeakLivekitCpu {
    param([string]$File)
    if (-not (Test-Path $File)) { return $null }
    $peaks = @()
    foreach ($line in [System.IO.File]::ReadLines($File)) {
        if ($line -notmatch 'livekit') { continue }
        if ($line -match 'egress') { continue }
        $bits = $line -split '\|'
        # ts | name | cpu% | mem | mem%
        if ($bits.Count -ge 3) {
            $v = 0.0
            if ([double]::TryParse(($bits[2] -replace '%', ''), [ref]$v)) { $peaks += $v }
        }
    }
    if ($peaks.Count -eq 0) { return $null }
    return ($peaks | Measure-Object -Maximum).Maximum
}

function Test-RoomSuccess {
    param($Item, [int]$DurationSeconds)
    $stderr = ""
    $stdout = ""
    if (Test-Path $Item.StdErr) { $stderr = [System.IO.File]::ReadAllText($Item.StdErr) }
    if (Test-Path $Item.StdOut) { $stdout = [System.IO.File]::ReadAllText($Item.StdOut) }
    $text = $stderr + "`n" + $stdout
    $connected = $text -match 'Finished connecting|publishing simulcast|publishing.*video'
    $failedHard = $text -match '(?i)could not|permission denied|unauthorized|panic|connection refused'
    $ranLongEnough = $Item.ElapsedSeconds -ge [Math]::Max(5, [int]($DurationSeconds * 0.8))
    $exitOk = $false
    try {
        if ($Item.Process.HasExited -and $Item.Process.ExitCode -eq 0) { $exitOk = $true }
    }
    catch { }

    $ok = ($connected -and -not $failedHard -and ($exitOk -or $ranLongEnough))
    return [PSCustomObject]@{
        Ok              = [bool]$ok
        Connected       = [bool]$connected
        FailedHard      = [bool]$failedHard
        RanLongEnough   = [bool]$ranLongEnough
        ExitOk          = [bool]$exitOk
        ElapsedSeconds  = $Item.ElapsedSeconds
        Snippet         = if ($text.Length -gt 0) { $text.Substring(0, [Math]::Min(300, $text.Length)) } else { "" }
    }
}

$levelResults = @()

foreach ($n in $roomLevels) {
    Write-Host "`n=== Media rooms (2 video pubs each): $n for ${DurationSeconds}s @ $VideoResolution ==="
    $logDir = Join-Path $OutDir "logs-rooms-$n"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    $snapBefore = Get-DockerStatsSnapshot
    $procs = @()
    $roomNames = @()
    $startedAt = [DateTimeOffset]::UtcNow
    # Per-level docker stats so peak CPU is not polluted by earlier ladder steps
    $levelStatsFile = Join-Path $OutDir "docker-stats-rooms-$n.tsv"
    if (-not $SkipDockerStats) {
        Set-Content -LiteralPath $levelStatsFile -Value "timestamp|name|cpu|memUsage|memPct" -Encoding UTF8
    }

    for ($i = 0; $i -lt $n; $i++) {
        $room = "cap-media-{0:D2}-{1}" -f $i, ([guid]::NewGuid().ToString("N").Substring(0, 8))
        $roomNames += $room
        $stdout = Join-Path $logDir "$room.stdout.log"
        $stderr = Join-Path $logDir "$room.stderr.log"
        # Extra seconds so CLI can exit cleanly before we stop waiting
        $cliDuration = $DurationSeconds
        $args = @(
            "load-test",
            "--url", $httpUrl,
            "--api-key", $apiKey,
            "--api-secret", $apiSecret,
            "--room", $room,
            "--video-publishers", "2",
            "--subscribers", "$SubscribersPerRoom",
            "--duration", "${cliDuration}s",
            "--video-resolution", $VideoResolution,
            "--num-per-second", "10"
        )
        $p = Start-Process -FilePath $lk -ArgumentList $args `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr `
            -PassThru -WindowStyle Hidden
        $procs += [PSCustomObject]@{
            Room           = $room
            Process        = $p
            StdOut         = $stdout
            StdErr         = $stderr
            Started        = Get-Date
            ElapsedSeconds = 0
        }
        Write-Host "  started room $room pid=$($p.Id)"
    }

    # Let publishers connect before first rate sample
    Start-Sleep -Seconds 4
    $promBefore = $null
    $promMid = $null
    $promAfter = $null
    $promRates = $null
    $promRatesMid = $null
    if (-not $SkipPrometheus) {
        $promBefore = Get-PrometheusMetricSamples -MetricsUrl $MetricsUrl
        Append-LivekitMetricsTsv -File $promFile -Sample $promBefore
    }

    $waitUntil = (Get-Date).AddSeconds($DurationSeconds + 20)
    $midTaken = $false
    while ((Get-Date) -lt $waitUntil) {
        Append-DockerStatsSample -File $statsFile
        if (-not $SkipDockerStats) { Append-DockerStatsSample -File $levelStatsFile }
        $elapsedLevel = ((Get-Date) - $startedAt.LocalDateTime).TotalSeconds
        if (-not $SkipPrometheus -and -not $midTaken -and $elapsedLevel -ge ($DurationSeconds / 2.0)) {
            $promMid = Get-PrometheusMetricSamples -MetricsUrl $MetricsUrl
            if ($promBefore -and $promMid) {
                $promRatesMid = Get-PrometheusRateSnapshot -Before $promBefore -After $promMid
                Append-LivekitMetricsTsv -File $promFile -Sample $promMid -Rates $promRatesMid
            }
            $midTaken = $true
        }
        $alive = 0
        foreach ($item in $procs) {
            if (-not $item.Process.HasExited) { $alive++ }
            $item.ElapsedSeconds = [int]((Get-Date) - $item.Started).TotalSeconds
        }
        if ($alive -eq 0 -and ((Get-Date) - $startedAt.LocalDateTime).TotalSeconds -ge $DurationSeconds) {
            break
        }
        Start-Sleep -Seconds 2
    }

    # Sample Prometheus while media is still flowing (before killing CLI processes)
    $endedAt = [DateTimeOffset]::UtcNow
    $snapAfter = Get-DockerStatsSnapshot
    Append-DockerStatsSample -File $statsFile
    if (-not $SkipPrometheus) {
        $promAfter = Get-PrometheusMetricSamples -MetricsUrl $MetricsUrl
        if ($promBefore -and $promAfter) {
            $promRates = Get-PrometheusRateSnapshot -Before $promBefore -After $promAfter
            Append-LivekitMetricsTsv -File $promFile -Sample $promAfter -Rates $promRates
        }
    }

    foreach ($item in $procs) {
        $item.ElapsedSeconds = [int]((Get-Date) - $item.Started).TotalSeconds
        if (-not $item.Process.HasExited) {
            try {
                $item.Process.CloseMainWindow() | Out-Null
            }
            catch { }
            Start-Sleep -Milliseconds 500
            if (-not $item.Process.HasExited) {
                try { Stop-Process -Id $item.Process.Id -Force -ErrorAction SilentlyContinue } catch { }
            }
        }
    }
    Start-Sleep -Seconds 1

    $judgements = @()
    $exitOk = 0
    $exitFail = 0
    foreach ($item in $procs) {
        $j = Test-RoomSuccess -Item $item -DurationSeconds $DurationSeconds
        $judgements += $j
        if ($j.Ok) { $exitOk++ } else { $exitFail++ }
        if (-not $j.Ok) {
            Write-Host "  FAIL $($item.Room): connected=$($j.Connected) long=$($j.RanLongEnough) exitOk=$($j.ExitOk) elapsed=$($j.ElapsedSeconds)s"
        }
    }

    $livekit = $snapAfter | Where-Object { $_.Name -match 'livekit' -and $_.Name -notmatch 'egress' } | Select-Object -First 1
    $egress = $snapAfter | Where-Object { $_.Name -match 'egress' } | Select-Object -First 1
    $backend = $snapAfter | Where-Object { $_.Name -match 'backend' } | Select-Object -First 1
    $peakLivekitCpu = Get-PeakLivekitCpu -File $levelStatsFile
    if ($null -eq $peakLivekitCpu) { $peakLivekitCpu = Get-PeakLivekitCpu -File $statsFile }

    $successRate = if ($n -gt 0) { [Math]::Round(100.0 * $exitOk / $n, 1) } else { 0 }
    $row = [PSCustomObject]@{
        concurrentRooms     = $n
        videoPublishersEach = 2
        subscribersEach     = $SubscribersPerRoom
        durationSeconds     = $DurationSeconds
        videoResolution     = $VideoResolution
        processesOk         = $exitOk
        processesFail       = $exitFail
        successRatePercent  = $successRate
        livekitCpuAfter     = $livekit.CpuPercent
        livekitMemAfter     = $livekit.MemUsage
        livekitCpuPeakSeen  = $peakLivekitCpu
        backendCpuAfter     = $backend.CpuPercent
        egressCpuAfter      = $egress.CpuPercent
        # Prometheus-derived (SFU-observed media)
        mbpsIn              = if ($promRates) { $promRates.mbpsIn } else { $null }
        mbpsOut             = if ($promRates) { $promRates.mbpsOut } else { $null }
        mbpsTotal           = if ($promRates) { $promRates.mbpsTotal } else { $null }
        packetsInPerSec     = if ($promRates) { $promRates.packetsInPerSec } else { $null }
        packetsOutPerSec    = if ($promRates) { $promRates.packetsOutPerSec } else { $null }
        lossAvgPercent      = if ($promRates) { $promRates.lossAvgPercentEnd } else { $null }
        oooAvgPercent       = if ($promRates) { $promRates.oooAvgPercentEnd } else { $null }
        nodeDropPercent     = if ($promRates) { $promRates.nodeDropPercent } else { $null }
        roomsGauge          = if ($promRates) { $promRates.roomsEnd } else { $null }
        participantsGauge   = if ($promRates) { $promRates.participantsEnd } else { $null }
        tracksVideoGauge    = if ($promRates) { $promRates.tracksVideoEnd } else { $null }
        mbpsInMid           = if ($promRatesMid) { $promRatesMid.mbpsIn } else { $null }
        mbpsOutMid          = if ($promRatesMid) { $promRatesMid.mbpsOut } else { $null }
        prometheusRates     = $promRates
        prometheusRatesMid  = $promRatesMid
        roomNames           = $roomNames
        judgements          = $judgements
        startedAtUtc        = $startedAt.ToString("o")
        endedAtUtc          = $endedAt.ToString("o")
        dockerBefore        = $snapBefore
        dockerAfter         = $snapAfter
    }
    $levelResults += $row

    Write-Host ("  ok={0}/{1} ({2}%) livekitCPU={3}% peak~{4}% mem={5}" -f `
        $exitOk, $n, $successRate, $livekit.CpuPercent, $peakLivekitCpu, $livekit.MemUsage)
    if ($promRates -and $promRates.ok) {
        Write-Host ("  media: in={0} Mbps out={1} Mbps total={2} Mbps | pkt/s in={3} out={4} | loss~{5}% drop~{6}% | rooms={7} parts={8}" -f `
            $promRates.mbpsIn, $promRates.mbpsOut, $promRates.mbpsTotal, `
            $promRates.packetsInPerSec, $promRates.packetsOutPerSec, `
            $promRates.lossAvgPercentEnd, $promRates.nodeDropPercent, `
            $promRates.roomsEnd, $promRates.participantsEnd)
    }

    Start-Sleep -Seconds 3
}

$maxOk = 0
foreach ($lr in $levelResults) {
    if ($lr.successRatePercent -ge 100 -and $lr.concurrentRooms -gt $maxOk) {
        $maxOk = $lr.concurrentRooms
    }
}

$report = [ordered]@{
    kind                 = "media-load"
    liveKitUrl           = $httpUrl
    metricsUrl           = $MetricsUrl
    durationSeconds      = $DurationSeconds
    videoResolution      = $VideoResolution
    subscribersPerRoom   = $SubscribersPerRoom
    concurrentRoomLevels = $roomLevels
    topologyNote         = "Each room = 2 video publishers + N subscribers (CLI). Bitrate/loss from LiveKit Prometheus livekit_packet_* counters — SFU-observed, not browser getStats."
    maxFullSuccessRooms  = $maxOk
    levels               = $levelResults
}

Write-JsonFile -Object $report -Path (Join-Path $OutDir "media-load-report.json")

$md = @()
$md += "# Media SFU load test report"
$md += ""
$md += "- LiveKit: ``$httpUrl``"
$md += "- Prometheus: ``$MetricsUrl``"
$md += "- Topology: **N rooms × 2 video publishers + $SubscribersPerRoom subscribers**"
$md += "- Resolution: $VideoResolution · Duration: ${DurationSeconds}s"
$md += "- Max rooms with **100% success**: **$maxOk**"
$md += "- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0)."
$md += "- **Mbps / loss** from LiveKit ``/metrics`` (``livekit_packet_bytes``, ``livekit_packet_loss_percent_*``) over the level window."
$md += "- CLI publishers ≠ browser encode; local Docker path ≠ multi-network WAN."
$md += ""
$md += "| Rooms | OK | CPU peak% | Mbps in | Mbps out | Mbps total | Mid total Mbps | pkt/s in | loss% | rooms | parts |"
$md += "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
foreach ($lr in $levelResults) {
    $midTotal = $null
    if ($null -ne $lr.mbpsInMid -and $null -ne $lr.mbpsOutMid) {
        $midTotal = [Math]::Round(([double]$lr.mbpsInMid + [double]$lr.mbpsOutMid), 3)
    }
    $md += "| $($lr.concurrentRooms) | $($lr.processesOk)/$($lr.concurrentRooms) | $($lr.livekitCpuPeakSeen) | $($lr.mbpsIn) | $($lr.mbpsOut) | $($lr.mbpsTotal) | $midTotal | $($lr.packetsInPerSec) | $($lr.lossAvgPercent) | $($lr.roomsGauge) | $($lr.participantsGauge) |"
}
$md += ""
$md += "Artifacts: ``media-load-report.json``, ``docker-stats.tsv``, ``livekit-metrics.tsv``, ``logs-rooms-*/``"
$md -join "`n" | Set-Content -LiteralPath (Join-Path $OutDir "SUMMARY.md") -Encoding UTF8

Write-Host "`nWrote $OutDir\SUMMARY.md"
Write-Host "Max full-success media rooms: $maxOk"
$anyFail = $levelResults | Where-Object { $_.processesFail -gt 0 }
if ($anyFail) { exit 1 }
exit 0
