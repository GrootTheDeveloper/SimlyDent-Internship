<#
.SYNOPSIS
  Concurrent API/signaling capacity test for LiveKit 1:1 PoC (JWT).

.DESCRIPTION
  Ladder of concurrent 1:1 pairs using synthetic users L01..Lxx:
  login → create call → accept → media token → hold → end.
  Captures per-step latency, success rate, busy-check, and docker stats samples.

.EXAMPLE
  .\scripts\api-load-test.ps1 -ConcurrentLevels @(1,2,3,5) -HoldSeconds 8
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$DemoPassword = "Demo@123",
    # Comma-separated for -File-safe CLI: "1,2,3,5,8" (int[] breaks under powershell -File)
    [string]$ConcurrentLevels = "1,2,3,5,8",
    [int]$HoldSeconds = 8,
    [int]$MaxPairsAvailable = 20,
    [string]$OutDir,
    [switch]$SkipDockerStats
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\poc-load-common.ps1")

function Parse-IntList([string]$Text, [int[]]$Fallback) {
    if ([string]::IsNullOrWhiteSpace($Text)) { return $Fallback }
    $parts = @($Text -split '[,;\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
    if ($parts.Count -eq 0) { return $Fallback }
    return $parts
}
$levelList = Parse-IntList $ConcurrentLevels @(1, 2, 3, 5, 8)

$root = Get-PocRoot
if (-not $OutDir) { $OutDir = New-LoadReportDir -Root $root -Prefix "api-load" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "API load report dir: $OutDir"
Write-Host "ApiUrl=$ApiUrl HoldSeconds=$HoldSeconds Levels=$($levelList -join ',')"

# Health
$health = Invoke-WebRequest -Uri "$ApiUrl/health" -UseBasicParsing
if ($health.StatusCode -ne 200) { throw "API unhealthy" }

# Probe load user L01 exists (backend rebuild required)
$probeCache = @{}
try {
    $null = Get-PocAccessToken -ApiUrl $ApiUrl -UserId "L01" -Password $DemoPassword -Cache $probeCache
}
catch {
    throw @"
Cannot login load user L01. Rebuild backend so IdentityRegistry includes L01..Lxx.
Original: $($_.Exception.Message)
"@
}

$statsFile = Join-Path $OutDir "docker-stats.tsv"
if (-not $SkipDockerStats) {
    Set-Content -LiteralPath $statsFile -Value "timestamp|name|cpu|memUsage|memPct" -Encoding UTF8
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

$levelResults = @()
$allPairDetails = @()

function Invoke-OnePair {
    param(
        [string]$ApiUrl,
        [string]$CallerId,
        [string]$CalleeId,
        [string]$Password,
        [int]$HoldSeconds,
        [int]$Level,
        [int]$PairIndex
    )

    $swTotal = [System.Diagnostics.Stopwatch]::StartNew()
    $detail = [ordered]@{
        level           = $Level
        pairIndex       = $PairIndex
        callerId        = $CallerId
        calleeId        = $CalleeId
        ok              = $false
        callId          = $null
        loginMs         = $null
        createMs        = $null
        acceptMs        = $null
        tokenMs         = $null
        endMs           = $null
        totalMs         = $null
        createStatus    = $null
        acceptStatus    = $null
        tokenStatus     = $null
        endStatus       = $null
        error           = $null
    }

    try {
        $cache = @{}
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $callerHeaders = Get-PocAuthHeaders -ApiUrl $ApiUrl -UserId $CallerId -Password $Password -Cache $cache
        $calleeHeaders = Get-PocAuthHeaders -ApiUrl $ApiUrl -UserId $CalleeId -Password $Password -Cache $cache
        $sw.Stop(); $detail.loginMs = $sw.ElapsedMilliseconds

        $sw.Restart()
        $create = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls" -Headers $callerHeaders -Body @{ calleeId = $CalleeId }
        $sw.Stop(); $detail.createMs = $sw.ElapsedMilliseconds; $detail.createStatus = $create.StatusCode
        if ($create.StatusCode -ne 201) { throw "create expected 201 got $($create.StatusCode): $($create.Content)" }
        $callId = $create.Json.id
        $detail.callId = "$callId"

        $sw.Restart()
        $accept = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls/$callId/accept" -Headers $calleeHeaders
        $sw.Stop(); $detail.acceptMs = $sw.ElapsedMilliseconds; $detail.acceptStatus = $accept.StatusCode
        if ($accept.StatusCode -ne 200) { throw "accept expected 200 got $($accept.StatusCode): $($accept.Content)" }

        $sw.Restart()
        $token = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls/$callId/token" -Headers $callerHeaders
        $sw.Stop(); $detail.tokenMs = $sw.ElapsedMilliseconds; $detail.tokenStatus = $token.StatusCode
        if ($token.StatusCode -ne 200 -or [string]::IsNullOrWhiteSpace($token.Json.token)) {
            throw "token expected 200 with body, got $($token.StatusCode)"
        }

        if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }

        $sw.Restart()
        $end = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls/$callId/end" -Headers $callerHeaders
        $sw.Stop(); $detail.endMs = $sw.ElapsedMilliseconds; $detail.endStatus = $end.StatusCode
        if ($end.StatusCode -ne 200) { throw "end expected 200 got $($end.StatusCode): $($end.Content)" }

        $detail.ok = $true
    }
    catch {
        $detail.error = "$_"
    }
    finally {
        $swTotal.Stop()
        $detail.totalMs = $swTotal.ElapsedMilliseconds
    }
    return [PSCustomObject]$detail
}

function Invoke-ConcurrentPairs {
    param(
        [int]$PairCount,
        [string]$ApiUrl,
        [string]$Password,
        [int]$HoldSeconds,
        [int]$Level
    )

    $runspacePool = [runspacefactory]::CreateRunspacePool(1, [Math]::Min($PairCount, 20))
    $runspacePool.Open()
    $pipeline = {
        param($ApiUrl, $CallerId, $CalleeId, $Password, $HoldSeconds, $Level, $PairIndex, $CommonPath)
        . $CommonPath
        return Invoke-OnePair -ApiUrl $ApiUrl -CallerId $CallerId -CalleeId $CalleeId `
            -Password $Password -HoldSeconds $HoldSeconds -Level $Level -PairIndex $PairIndex
    }

    # Define Invoke-OnePair inside each runspace by re-dot-sourcing won't include function from parent.
    # Inline the pair logic in the scriptblock instead.
    $worker = {
        param($ApiUrl, $CallerId, $CalleeId, $Password, $HoldSeconds, $Level, $PairIndex)

        function Get-Tok([string]$Uid) {
            $body = @{ userId = $Uid; password = $Password } | ConvertTo-Json -Compress
            $login = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/login" -ContentType "application/json" -Body $body
            return $login.accessToken
        }
        function ApiCall([string]$Method, [string]$Path, [string]$Token, $Body) {
            $headers = @{ Authorization = "Bearer $Token" }
            $p = @{ Method = $Method; Uri = "$ApiUrl$Path"; Headers = $headers; UseBasicParsing = $true }
            if ($null -ne $Body) {
                $p.ContentType = "application/json"
                $p.Body = ($Body | ConvertTo-Json -Compress)
            }
            try {
                $r = Invoke-WebRequest @p
                return @{ Status = [int]$r.StatusCode; Content = $r.Content; Json = if ($r.Content) { $r.Content | ConvertFrom-Json } else { $null } }
            }
            catch {
                $st = $null; $c = $_.Exception.Message
                if ($_.Exception.Response) {
                    $st = [int]$_.Exception.Response.StatusCode
                    try {
                        $reader = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                        try { $c = $reader.ReadToEnd() } finally { $reader.Dispose() }
                    } catch {}
                }
                $j = $null; try { $j = $c | ConvertFrom-Json } catch {}
                return @{ Status = $st; Content = $c; Json = $j }
            }
        }

        $detail = [ordered]@{
            level = $Level; pairIndex = $PairIndex; callerId = $CallerId; calleeId = $CalleeId
            ok = $false; callId = $null
            loginMs = $null; createMs = $null; acceptMs = $null; tokenMs = $null; endMs = $null; totalMs = $null
            createStatus = $null; acceptStatus = $null; tokenStatus = $null; endStatus = $null; error = $null
        }
        $swTotal = [Diagnostics.Stopwatch]::StartNew()
        try {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $tCaller = Get-Tok $CallerId
            $tCallee = Get-Tok $CalleeId
            $sw.Stop(); $detail.loginMs = $sw.ElapsedMilliseconds

            $sw.Restart()
            $create = ApiCall "POST" "/api/calls" $tCaller @{ calleeId = $CalleeId }
            $sw.Stop(); $detail.createMs = $sw.ElapsedMilliseconds; $detail.createStatus = $create.Status
            if ($create.Status -ne 201) { throw "create $($create.Status) $($create.Content)" }
            $callId = $create.Json.id
            $detail.callId = "$callId"

            $sw.Restart()
            $accept = ApiCall "POST" "/api/calls/$callId/accept" $tCallee $null
            $sw.Stop(); $detail.acceptMs = $sw.ElapsedMilliseconds; $detail.acceptStatus = $accept.Status
            if ($accept.Status -ne 200) { throw "accept $($accept.Status) $($accept.Content)" }

            $sw.Restart()
            $token = ApiCall "POST" "/api/calls/$callId/token" $tCaller $null
            $sw.Stop(); $detail.tokenMs = $sw.ElapsedMilliseconds; $detail.tokenStatus = $token.Status
            if ($token.Status -ne 200) { throw "token $($token.Status) $($token.Content)" }

            if ($HoldSeconds -gt 0) { Start-Sleep -Seconds $HoldSeconds }

            $sw.Restart()
            $end = ApiCall "POST" "/api/calls/$callId/end" $tCaller $null
            $sw.Stop(); $detail.endMs = $sw.ElapsedMilliseconds; $detail.endStatus = $end.Status
            if ($end.Status -ne 200) { throw "end $($end.Status) $($end.Content)" }
            $detail.ok = $true
        }
        catch { $detail.error = "$_" }
        finally { $swTotal.Stop(); $detail.totalMs = $swTotal.ElapsedMilliseconds }
        return [PSCustomObject]$detail
    }

    $handles = @()
    for ($i = 0; $i -lt $PairCount; $i++) {
        $callerIdx = (2 * $i) + 1
        $calleeIdx = (2 * $i) + 2
        $callerId = Format-LoadUserId $callerIdx
        $calleeId = Format-LoadUserId $calleeIdx
        $ps = [powershell]::Create().AddScript($worker).AddArgument($ApiUrl).AddArgument($callerId).AddArgument($calleeId).AddArgument($Password).AddArgument($HoldSeconds).AddArgument($Level).AddArgument($i)
        $ps.RunspacePool = $runspacePool
        $handles += [PSCustomObject]@{ Pipe = $ps; Status = $ps.BeginInvoke() }
    }

    $results = @()
    foreach ($h in $handles) {
        $results += $h.Pipe.EndInvoke($h.Status)
        $h.Pipe.Dispose()
    }
    $runspacePool.Close()
    $runspacePool.Dispose()
    return $results
}

# --- Busy rule check (while one pair held) ---
Write-Host "`n=== Busy-rule check (L01↔L02 held, L03→L01) ==="
$busyOk = $false
$busyDetail = $null
try {
    $bc = @{}
    $h1 = Get-PocAuthHeaders -ApiUrl $ApiUrl -UserId "L01" -Password $DemoPassword -Cache $bc
    $h2 = Get-PocAuthHeaders -ApiUrl $ApiUrl -UserId "L02" -Password $DemoPassword -Cache $bc
    $h3 = Get-PocAuthHeaders -ApiUrl $ApiUrl -UserId "L03" -Password $DemoPassword -Cache $bc
    $c = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls" -Headers $h1 -Body @{ calleeId = "L02" }
    if ($c.StatusCode -ne 201) { throw "setup create failed $($c.StatusCode)" }
    $cid = $c.Json.id
    $a = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls/$cid/accept" -Headers $h2
    if ($a.StatusCode -ne 200) { throw "setup accept failed $($a.StatusCode)" }
    $busy = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls" -Headers $h3 -Body @{ calleeId = "L01" }
    $busyOk = ($busy.StatusCode -eq 409)
    $busyDetail = "status=$($busy.StatusCode) body=$($busy.Content)"
    $null = Invoke-PocApi -ApiUrl $ApiUrl -Method POST -Path "/api/calls/$cid/end" -Headers $h1
    Write-Host "Busy check: $(if ($busyOk) { 'PASS' } else { 'FAIL' }) ($busyDetail)"
}
catch {
    $busyDetail = "$_"
    Write-Host "Busy check: ERROR $busyDetail"
}

foreach ($n in $levelList) {
        if ($n -gt $MaxPairsAvailable) {
            Write-Host "Skip level $n (max pairs $MaxPairsAvailable)"
            continue
        }
        if ((2 * $n) -gt 40) {
            Write-Host "Skip level $n (need more load users)"
            continue
        }

        Write-Host "`n=== Concurrent pairs: $n (hold ${HoldSeconds}s) ==="
        Append-DockerStatsSample -File $statsFile
        $snapBefore = Get-DockerStatsSnapshot
        $swLevel = [System.Diagnostics.Stopwatch]::StartNew()
        $pairs = @(Invoke-ConcurrentPairs -PairCount $n -ApiUrl $ApiUrl -Password $DemoPassword -HoldSeconds $HoldSeconds -Level $n)
        $swLevel.Stop()
        Append-DockerStatsSample -File $statsFile
        $snapAfter = Get-DockerStatsSnapshot

        $okCount = @($pairs | Where-Object { $_.ok }).Count
        $failCount = $pairs.Count - $okCount
        $totals = @($pairs | ForEach-Object { $_.totalMs })
        $creates = @($pairs | Where-Object { $null -ne $_.createMs } | ForEach-Object { $_.createMs })

        function Stats($arr) {
            if (-not $arr -or $arr.Count -eq 0) {
                return @{ min = $null; max = $null; avg = $null; p50 = $null }
            }
            $s = $arr | Sort-Object
            $avg = ($s | Measure-Object -Average).Average
            $p50 = $s[[int][Math]::Floor(($s.Count - 1) * 0.5)]
            return @{ min = $s[0]; max = $s[-1]; avg = [Math]::Round($avg, 1); p50 = $p50 }
        }

        $tStats = Stats $totals
        $cStats = Stats $creates
        $successRate = if ($pairs.Count -gt 0) { [Math]::Round(100.0 * $okCount / $pairs.Count, 1) } else { 0 }

        $livekitCpu = ($snapAfter | Where-Object { $_.Name -match 'livekit' -and $_.Name -notmatch 'egress' } | Select-Object -First 1).CpuPercent
        $backendCpu = ($snapAfter | Where-Object { $_.Name -match 'backend' } | Select-Object -First 1).CpuPercent

        $summary = [PSCustomObject]@{
            concurrentPairs     = $n
            successCount        = $okCount
            failCount           = $failCount
            successRatePercent  = $successRate
            wallClockMs         = $swLevel.ElapsedMilliseconds
            totalMs_min         = $tStats.min
            totalMs_p50         = $tStats.p50
            totalMs_avg         = $tStats.avg
            totalMs_max         = $tStats.max
            createMs_p50        = $cStats.p50
            createMs_avg        = $cStats.avg
            livekitCpuAfter     = $livekitCpu
            backendCpuAfter     = $backendCpu
            dockerAfter         = $snapAfter
            dockerBefore        = $snapBefore
        }
        $levelResults += $summary
        $allPairDetails += $pairs

        Write-Host ("  success={0}/{1} ({2}%) wall={3}ms total p50={4}ms avg={5}ms max={6}ms livekitCPU={7}% backendCPU={8}%" -f `
            $okCount, $pairs.Count, $successRate, $swLevel.ElapsedMilliseconds, `
            $tStats.p50, $tStats.avg, $tStats.max, $livekitCpu, $backendCpu)
        $pairs | Where-Object { -not $_.ok } | ForEach-Object {
            Write-Host "  FAIL pair $($_.pairIndex) $($_.callerId)→$($_.calleeId): $($_.error)"
        }

        # Brief cool-down so busy timeouts / state settle
        Start-Sleep -Seconds 2
}
$maxOk = 0
foreach ($lr in $levelResults) {
    if ($lr.successRatePercent -ge 100 -and $lr.concurrentPairs -gt $maxOk) {
        $maxOk = $lr.concurrentPairs
    }
}

$report = [ordered]@{
    kind                = "api-load"
    startedAtUtc        = (Get-Date).ToUniversalTime().ToString("o")
    apiUrl              = $ApiUrl
    holdSeconds         = $HoldSeconds
    concurrentLevels    = $levelList
    busyRulePass        = $busyOk
    busyRuleDetail      = $busyDetail
    maxFullSuccessPairs = $maxOk
    levels              = $levelResults
    pairs               = $allPairDetails
}

Write-JsonFile -Object $report -Path (Join-Path $OutDir "api-load-report.json")
$allPairDetails | Export-Csv -NoTypeInformation -Encoding UTF8 -Path (Join-Path $OutDir "api-load-pairs.csv")

$md = @()
$md += "# API load test report"
$md += ""
$md += "- API: ``$ApiUrl``"
$md += "- Hold: ${HoldSeconds}s per accepted call"
$md += "- Busy rule (L03→busy L01): **$(if ($busyOk) { 'PASS' } else { 'FAIL' })** — $busyDetail"
$md += "- Max concurrent pairs with **100% success**: **$maxOk**"
$md += ""
$md += "| Pairs | Success | Rate % | Wall ms | total p50 | total avg | total max | LiveKit CPU% | Backend CPU% |"
$md += "|---:|---:|---:|---:|---:|---:|---:|---:|---:|"
foreach ($lr in $levelResults) {
    $md += "| $($lr.concurrentPairs) | $($lr.successCount)/$($lr.successCount + $lr.failCount) | $($lr.successRatePercent) | $($lr.wallClockMs) | $($lr.totalMs_p50) | $($lr.totalMs_avg) | $($lr.totalMs_max) | $($lr.livekitCpuAfter) | $($lr.backendCpuAfter) |"
}
$md += ""
$md += "Artifacts: ``api-load-report.json``, ``api-load-pairs.csv``, ``docker-stats.tsv``"
$md -join "`n" | Set-Content -LiteralPath (Join-Path $OutDir "SUMMARY.md") -Encoding UTF8

Write-Host "`nWrote $OutDir\SUMMARY.md"
Write-Host "Max full-success concurrent pairs: $maxOk"
if (-not $busyOk) { exit 2 }
$anyFail = $levelResults | Where-Object { $_.failCount -gt 0 }
if ($anyFail) { exit 1 }
exit 0
