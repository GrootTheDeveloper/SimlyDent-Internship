# Shared helpers for API / media capacity load tests (PowerShell 5.1+).
# Captured at dot-source time (this file lives in scripts/lib).
$script:PocLoadLibDir = $PSScriptRoot

function Get-PocRoot {
    # scripts/lib → scripts → poc root
    Split-Path -Parent (Split-Path -Parent $script:PocLoadLibDir)
}

function Read-PocEnv {
    param([string]$Root = (Get-PocRoot))
    $map = @{}
    $envPath = Join-Path $Root ".env"
    if (Test-Path -LiteralPath $envPath) {
        Get-Content -LiteralPath $envPath | ForEach-Object {
            if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
            if ($_ -match '^\s*([^=]+)=(.*)$') {
                $map[$matches[1].Trim()] = $matches[2].Trim().Trim('"')
            }
        }
    }
    return $map
}

function Get-PocAccessToken {
    param(
        [string]$ApiUrl,
        [string]$UserId,
        [string]$Password = "Demo@123",
        [hashtable]$Cache
    )
    if ($null -ne $Cache -and $Cache.ContainsKey($UserId)) {
        return $Cache[$UserId]
    }
    $body = @{ userId = $UserId; password = $Password } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/login" `
        -ContentType "application/json" -Body $body
    if ([string]::IsNullOrWhiteSpace($login.accessToken)) {
        throw "Empty accessToken for $UserId"
    }
    if ($null -ne $Cache) { $Cache[$UserId] = $login.accessToken }
    return $login.accessToken
}

function Get-PocAuthHeaders {
    param(
        [string]$ApiUrl,
        [string]$UserId,
        [string]$Password = "Demo@123",
        [hashtable]$Cache
    )
    $token = Get-PocAccessToken -ApiUrl $ApiUrl -UserId $UserId -Password $Password -Cache $Cache
    return @{ Authorization = "Bearer $token" }
}

function Invoke-PocApi {
    param(
        [string]$ApiUrl,
        [ValidateSet("GET", "POST")][string]$Method,
        [string]$Path,
        [hashtable]$Headers,
        [object]$Body = $null
    )
    $params = @{
        Method          = $Method
        Uri             = "$ApiUrl$Path"
        Headers         = $Headers
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $params.ContentType = "application/json"
        $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    }
    try {
        $resp = Invoke-WebRequest @params
        return @{
            StatusCode = [int]$resp.StatusCode
            Content    = $resp.Content
            Json       = if ([string]::IsNullOrWhiteSpace($resp.Content)) { $null } else { $resp.Content | ConvertFrom-Json }
            Error      = $null
        }
    }
    catch {
        $status = $null
        $content = $_.Exception.Message
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
            }
            catch { }
        }
        $json = $null
        try { if ($content) { $json = $content | ConvertFrom-Json } } catch { }
        return @{
            StatusCode = $status
            Content    = $content
            Json       = $json
            Error      = $_.Exception.Message
        }
    }
}

function Get-DockerStatsSnapshot {
    <#
      Returns array of containers with CPU% and memory.
      Requires docker CLI. Empty array if unavailable.
    #>
    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) { return @() }
    try {
        $raw = & docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>$null
        if (-not $raw) { return @() }
        $list = @()
        foreach ($line in $raw) {
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $parts = $line -split '\|', 4
            if ($parts.Count -lt 4) { continue }
            $cpu = 0.0
            $memPct = 0.0
            [void][double]::TryParse(($parts[1] -replace '%', ''), [ref]$cpu)
            [void][double]::TryParse(($parts[3] -replace '%', ''), [ref]$memPct)
            $list += [PSCustomObject]@{
                Name       = $parts[0]
                CpuPercent = $cpu
                MemUsage   = $parts[2]
                MemPercent = $memPct
                AtUtc      = [DateTimeOffset]::UtcNow.ToString("o")
            }
        }
        return $list
    }
    catch {
        return @()
    }
}

function Start-DockerStatsSampler {
    param(
        [string]$OutFile,
        [int]$IntervalSeconds = 2
    )
    $script = {
        param($OutFile, $IntervalSeconds)
        while ($true) {
            try {
                $lines = & docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>$null
                $ts = [DateTimeOffset]::UtcNow.ToString("o")
                foreach ($line in $lines) {
                    if ($line) { Add-Content -LiteralPath $OutFile -Value ($ts + "|" + $line) }
                }
            }
            catch { }
            Start-Sleep -Seconds $IntervalSeconds
        }
    }
    $job = Start-Job -ScriptBlock $script -ArgumentList $OutFile, $IntervalSeconds
    return $job
}

function Stop-DockerStatsSampler {
    param($Job)
    if ($null -eq $Job) { return }
    try {
        Stop-Job -Job $Job -ErrorAction SilentlyContinue
        Remove-Job -Job $Job -Force -ErrorAction SilentlyContinue
    }
    catch { }
}

function New-LoadReportDir {
    param(
        [string]$Root = (Get-PocRoot),
        [string]$Prefix = "capacity"
    )
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $dir = Join-Path $Root "evidence\capacity-runs\$Prefix-$stamp"
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function Write-JsonFile {
    param([object]$Object, [string]$Path)
    $Object | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $Path -Encoding UTF8
}

function Resolve-LiveKitCli {
    param([string]$Explicit)
    if ($Explicit -and (Test-Path -LiteralPath $Explicit)) { return $Explicit }
    $cmd = Get-Command lk -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:TEMP "simlydent-livekit-cli-2.18.2\lk.exe"
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

function Format-LoadUserId {
    param([int]$Index)
    # 1-based → L01, L02, ...
    return ("L{0:D2}" -f $Index)
}

# ---- LiveKit Prometheus helpers (port 6789 /metrics) ----

function Get-PrometheusMetricSamples {
    param(
        [string]$MetricsUrl = "http://localhost:6789/metrics",
        [int]$TimeoutSec = 5
    )
    $result = [ordered]@{
        ok          = $false
        atUtc       = [DateTimeOffset]::UtcNow.ToString("o")
        metricsUrl  = $MetricsUrl
        error       = $null
        # Counters (cumulative) — sum all label series
        bytesIn     = 0.0
        bytesOut    = 0.0
        packetsIn   = 0.0
        packetsOut  = 0.0
        packetsDropped = 0.0
        rooms       = 0.0
        participants = 0.0
        tracksVideo = 0.0
        # Histogram-derived
        lossSum     = 0.0
        lossCount   = 0.0
        lossAvgPercent = $null
        oooSum      = 0.0
        oooCount    = 0.0
        oooAvgPercent = $null
        forwardLatency = $null
        forwardJitter  = $null
        rawMatched  = @{}
    }
    try {
        $resp = Invoke-WebRequest -Uri $MetricsUrl -UseBasicParsing -TimeoutSec $TimeoutSec
        if ($resp.StatusCode -ne 200) {
            $result.error = "HTTP $($resp.StatusCode)"
            return [PSCustomObject]$result
        }
        foreach ($line in ($resp.Content -split "`n")) {
            if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) { continue }
            # metric{labels} value  OR  metric value
            if ($line -notmatch '^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?<labels>[^}]*)\})?\s+(?<value>[-+eE0-9.]+)\s*$') {
                continue
            }
            $name = $matches['name']
            $labels = $matches['labels']
            $value = 0.0
            if (-not [double]::TryParse($matches['value'], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$value)) {
                continue
            }

            switch -Regex ($name) {
                '^livekit_packet_bytes$' {
                    if ($labels -match 'direction="incoming"') { $result.bytesIn += $value }
                    elseif ($labels -match 'direction="outgoing"') { $result.bytesOut += $value }
                }
                '^livekit_packet_total$' {
                    if ($labels -match 'direction="incoming"') { $result.packetsIn += $value }
                    elseif ($labels -match 'direction="outgoing"') { $result.packetsOut += $value }
                }
                '^livekit_node_packet_total$' {
                    if ($labels -match 'type="dropped"') { $result.packetsDropped += $value }
                    elseif ($labels -match 'type="out"') { $result.packetsOut += $value }
                }
                '^livekit_room_total$' { $result.rooms += $value }
                '^livekit_participant_total$' { $result.participants += $value }
                '^livekit_track_published_total$' {
                    if ($labels -match 'kind="VIDEO"') { $result.tracksVideo += $value }
                }
                '^livekit_packet_loss_percent_sum$' {
                    if ($labels -match 'direction="incoming"') { $result.lossSum += $value }
                }
                '^livekit_packet_loss_percent_count$' {
                    if ($labels -match 'direction="incoming"') { $result.lossCount += $value }
                }
                '^livekit_packet_out_of_order_percent_sum$' {
                    if ($labels -match 'direction="incoming"') { $result.oooSum += $value }
                }
                '^livekit_packet_out_of_order_percent_count$' {
                    if ($labels -match 'direction="incoming"') { $result.oooCount += $value }
                }
                '^livekit_forward_latency$' { $result.forwardLatency = $value }
                '^livekit_forward_jitter$' { $result.forwardJitter = $value }
            }
        }
        if ($result.lossCount -gt 0) {
            $result.lossAvgPercent = [Math]::Round($result.lossSum / $result.lossCount, 4)
        }
        if ($result.oooCount -gt 0) {
            $result.oooAvgPercent = [Math]::Round($result.oooSum / $result.oooCount, 4)
        }
        $result.ok = $true
    }
    catch {
        $result.error = "$_"
    }
    return [PSCustomObject]$result
}

function Get-PrometheusRateSnapshot {
    <#
      Diff two cumulative samples → throughput rates over elapsed seconds.
    #>
    param(
        $Before,
        $After
    )
    if (-not $Before -or -not $After -or -not $Before.ok -or -not $After.ok) {
        return [PSCustomObject]@{
            ok = $false
            error = "missing samples"
            elapsedSec = $null
        }
    }
    $t0 = [DateTimeOffset]::Parse($Before.atUtc)
    $t1 = [DateTimeOffset]::Parse($After.atUtc)
    $elapsed = ($t1 - $t0).TotalSeconds
    if ($elapsed -le 0) { $elapsed = 0.001 }

    function Delta($a, $b) {
        $d = $b - $a
        if ($d -lt 0) { return 0.0 } # counter reset
        return $d
    }

    $dBytesIn = Delta $Before.bytesIn $After.bytesIn
    $dBytesOut = Delta $Before.bytesOut $After.bytesOut
    $dPktIn = Delta $Before.packetsIn $After.packetsIn
    $dPktOut = Delta $Before.packetsOut $After.packetsOut
    $dDrop = Delta $Before.packetsDropped $After.packetsDropped

    $mbpsIn = [Math]::Round(($dBytesIn * 8.0) / $elapsed / 1e6, 3)
    $mbpsOut = [Math]::Round(($dBytesOut * 8.0) / $elapsed / 1e6, 3)
    $mbpsTotal = [Math]::Round($mbpsIn + $mbpsOut, 3)

    # Approximate drop rate vs out packets if available
    $dropPct = $null
    if (($dPktOut + $dDrop) -gt 0) {
        $dropPct = [Math]::Round(100.0 * $dDrop / ($dPktOut + $dDrop), 4)
    }

    return [PSCustomObject]@{
        ok                 = $true
        elapsedSec         = [Math]::Round($elapsed, 2)
        bytesInDelta       = [Math]::Round($dBytesIn, 0)
        bytesOutDelta      = [Math]::Round($dBytesOut, 0)
        packetsInDelta     = [Math]::Round($dPktIn, 0)
        packetsOutDelta    = [Math]::Round($dPktOut, 0)
        packetsDroppedDelta = [Math]::Round($dDrop, 0)
        mbpsIn             = $mbpsIn
        mbpsOut            = $mbpsOut
        mbpsTotal          = $mbpsTotal
        packetsInPerSec    = [Math]::Round($dPktIn / $elapsed, 1)
        packetsOutPerSec   = [Math]::Round($dPktOut / $elapsed, 1)
        nodeDropPercent    = $dropPct
        # End-of-window gauges / histogram means
        roomsEnd           = $After.rooms
        participantsEnd    = $After.participants
        tracksVideoEnd     = $After.tracksVideo
        lossAvgPercentEnd  = $After.lossAvgPercent
        oooAvgPercentEnd   = $After.oooAvgPercent
        forwardLatencyEnd  = $After.forwardLatency
        forwardJitterEnd   = $After.forwardJitter
        sampleBeforeUtc    = $Before.atUtc
        sampleAfterUtc     = $After.atUtc
    }
}

function Append-LivekitMetricsTsv {
    param(
        [string]$File,
        $Sample,
        $Rates = $null
    )
    if (-not $File) { return }
    $exists = Test-Path -LiteralPath $File
    if (-not $exists) {
        $hdr = "atUtc|ok|bytesIn|bytesOut|packetsIn|packetsOut|dropped|rooms|participants|tracksVideo|lossAvgPct|oooAvgPct|mbpsIn|mbpsOut|mbpsTotal|error"
        Set-Content -LiteralPath $File -Value $hdr -Encoding UTF8
    }
    $mbpsIn = if ($Rates) { $Rates.mbpsIn } else { "" }
    $mbpsOut = if ($Rates) { $Rates.mbpsOut } else { "" }
    $mbpsT = if ($Rates) { $Rates.mbpsTotal } else { "" }
    $line = @(
        $Sample.atUtc
        $Sample.ok
        $Sample.bytesIn
        $Sample.bytesOut
        $Sample.packetsIn
        $Sample.packetsOut
        $Sample.packetsDropped
        $Sample.rooms
        $Sample.participants
        $Sample.tracksVideo
        $Sample.lossAvgPercent
        $Sample.oooAvgPercent
        $mbpsIn
        $mbpsOut
        $mbpsT
        ($Sample.error -replace '\|', ';')
    ) -join '|'
    [System.IO.File]::AppendAllText($File, $line + "`n")
}
