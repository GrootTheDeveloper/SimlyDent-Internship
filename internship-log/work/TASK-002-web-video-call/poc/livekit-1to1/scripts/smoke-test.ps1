param(
    [string]$ApiUrl = "http://localhost:5080"
)

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()

function Invoke-PocRequest {
    param(
        [ValidateSet("GET", "POST")][string]$Method,
        [string]$Path,
        [string]$UserId,
        [object]$Body,
        [int]$ExpectedStatus
    )

    $parameters = @{
        Method = $Method
        Uri = "$ApiUrl$Path"
        Headers = @{ "X-User-Id" = $UserId }
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $parameters.ContentType = "application/json"
        $parameters.Body = $Body | ConvertTo-Json -Depth 10 -Compress
    }

    try {
        $response = Invoke-WebRequest @parameters
        $statusCode = [int]$response.StatusCode
        $content = $response.Content
    }
    catch {
        if ($null -eq $_.Exception.Response) { throw }
        $statusCode = [int]$_.Exception.Response.StatusCode
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
    }
    $passed = $statusCode -eq $ExpectedStatus
    $results.Add([PSCustomObject]@{
        Test = "$Method $Path as $UserId"
        Expected = $ExpectedStatus
        Actual = $statusCode
        Result = if ($passed) { "PASS" } else { "FAIL" }
    })
    if (-not $passed) {
        throw "Expected HTTP $ExpectedStatus, got ${statusCode}: $content"
    }
    if ([string]::IsNullOrWhiteSpace($content)) { return $null }
    return $content | ConvertFrom-Json
}

$health = Invoke-WebRequest -Uri "$ApiUrl/health" -UseBasicParsing
if ($health.StatusCode -ne 200) { throw "Backend is not healthy." }

Invoke-PocRequest POST "/api/calls" "A1" @{ calleeId = "B1" } 403 | Out-Null

$call = Invoke-PocRequest POST "/api/calls" "A1" @{ calleeId = "A2" } 201
$callId = $call.id
Invoke-PocRequest GET "/api/calls/active" "A2" $null 200 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/token" "A1" $null 409 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/recording/start" "A1" $null 409 | Out-Null
Invoke-PocRequest GET "/api/calls/$callId" "B1" $null 404 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/recording/start" "B1" $null 404 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/accept" "A2" $null 200 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/accept" "A2" $null 409 | Out-Null

$tokenResponse = Invoke-PocRequest POST "/api/calls/$callId/token" "A1" $null 200
$jwtParts = $tokenResponse.token.Split('.')
if ($jwtParts.Count -ne 3) { throw "LiveKit token is not a three-part JWT." }
$payloadText = $jwtParts[1].Replace('-', '+').Replace('_', '/')
while ($payloadText.Length % 4) { $payloadText += '=' }
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadText)) | ConvertFrom-Json
if (-not $payload.video.roomJoin -or $payload.video.room -ne $call.roomName -or $payload.sub -ne "tenant-a:A1") {
    throw "LiveKit grants do not match the accepted call."
}
$results.Add([PSCustomObject]@{ Test = "JWT room/identity grants"; Expected = "scoped"; Actual = "scoped"; Result = "PASS" })

$qualityBatch = @{
    clientSessionId = "smoke-client"
    environment = @{
        userAgent = "smoke-test"
        platform = "Windows"
        screenWidth = 1280
        screenHeight = 720
    }
    samples = @(
        @{
            timestamp = [DateTimeOffset]::UtcNow.ToString("O")
            incoming = @{
                width = 1280
                height = 720
                fps = 30
                bitrateKbps = 1700
                packetLossPercent = 0.2
                jitterMs = 4
                roundTripTimeMs = 35
                framesDroppedDelta = 0
                freezeCountDelta = 0
                freezeDurationDeltaMs = 0
                qualityLimitationReason = "none"
                codec = "VP8"
            }
            outgoing = @{
                width = 1280
                height = 720
                fps = 30
                bitrateKbps = 1650
                packetLossPercent = 0.1
                roundTripTimeMs = 35
                qualityLimitationReason = "none"
                codec = "VP8"
            }
            connection = @{
                protocol = "udp"
                localCandidateType = "host"
                remoteCandidateType = "host"
                currentRoundTripTimeMs = 35
            }
        }
    )
}
Invoke-PocRequest POST "/api/calls/$callId/quality/samples" "B1" $qualityBatch 404 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/quality/samples" "A1" $qualityBatch 202 | Out-Null
$qualitySummary = Invoke-PocRequest GET "/api/calls/$callId/quality/summary" "A2" $null 200
if ($qualitySummary.sampleCount -lt 1 -or $qualitySummary.sessions[0].networkScore0To5 -ne 5) {
    throw "Quality summary did not contain the expected stored sample."
}
$results.Add([PSCustomObject]@{ Test = "Quality telemetry summary"; Expected = "sample + score"; Actual = "sample + score"; Result = "PASS" })

$qualityCsv = Invoke-WebRequest `
    -Uri "$ApiUrl/api/calls/$callId/quality/export?format=csv" `
    -Headers @{ "X-User-Id" = "A1" } `
    -UseBasicParsing
if ($qualityCsv.StatusCode -ne 200 -or $qualityCsv.Content -notmatch "incoming" -or $qualityCsv.Content -notmatch "outgoing") {
    throw "Quality CSV export did not contain both media directions."
}
$results.Add([PSCustomObject]@{ Test = "Quality telemetry CSV export"; Expected = "incoming + outgoing"; Actual = "incoming + outgoing"; Result = "PASS" })

$qualityJson = Invoke-PocRequest GET "/api/calls/$callId/quality/export?format=json" "A2" $null 200
if ($qualityJson.report.sampleCount -lt 1 -or $qualityJson.samples.Count -lt 1) {
    throw "Quality JSON export did not contain report and raw samples."
}
$results.Add([PSCustomObject]@{ Test = "Quality telemetry JSON export"; Expected = "report + samples"; Actual = "report + samples"; Result = "PASS" })

Invoke-PocRequest POST "/api/calls/$callId/end" "A1" $null 200 | Out-Null
Invoke-PocRequest POST "/api/calls/$callId/end" "A1" $null 409 | Out-Null

$busyCall = Invoke-PocRequest POST "/api/calls" "A2" @{ calleeId = "A3" } 201
Invoke-PocRequest POST "/api/calls/$($busyCall.id)/accept" "A3" $null 200 | Out-Null
Invoke-PocRequest POST "/api/calls" "A1" @{ calleeId = "A2" } 409 | Out-Null
Invoke-PocRequest POST "/api/calls/$($busyCall.id)/end" "A2" $null 200 | Out-Null

$results | Format-Table -AutoSize
if ($results.Result -contains "FAIL") { exit 1 }
Write-Host "Smoke test passed: $($results.Count) checks."
