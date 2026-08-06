param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$DemoPassword = "Demo@123"
)

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()
$tokenCache = @{}

function Get-AccessToken {
    param([string]$UserId)

    if ($tokenCache.ContainsKey($UserId)) {
        return $tokenCache[$UserId]
    }

    $loginBody = @{ userId = $UserId; password = $DemoPassword } | ConvertTo-Json -Compress
    try {
        $login = Invoke-RestMethod `
            -Method Post `
            -Uri "$ApiUrl/api/auth/login" `
            -ContentType "application/json" `
            -Body $loginBody
    }
    catch {
        throw "JWT login failed for user '$UserId': $($_.Exception.Message)"
    }

    if ([string]::IsNullOrWhiteSpace($login.accessToken)) {
        throw "JWT login for '$UserId' returned empty accessToken."
    }

    # ClinicId must be server-bound at login (clinic-a for A*, clinic-b for B*).
    $clinic = $login.user.clinicId
    if ([string]::IsNullOrWhiteSpace($clinic)) { $clinic = $login.user.tenantId }
    if ($UserId -match '^A' -and $clinic -ne 'clinic-a') {
        throw "Expected clinic-a for $UserId, got '$clinic'."
    }
    if ($UserId -eq 'B1' -and $clinic -ne 'clinic-b') {
        throw "Expected clinic-b for B1, got '$clinic'."
    }

    $tokenCache[$UserId] = $login.accessToken
    return $login.accessToken
}

function Get-AuthHeaders {
    param([string]$UserId)
    return @{ Authorization = "Bearer $(Get-AccessToken -UserId $UserId)" }
}

function Invoke-PocRequest {
    param(
        [ValidateSet("GET", "POST")][string]$Method,
        [string]$Path,
        [string]$UserId,
        [object]$Body,
        [int]$ExpectedStatus,
        [switch]$NoAuth
    )

    $parameters = @{
        Method = $Method
        Uri = "$ApiUrl$Path"
        UseBasicParsing = $true
    }
    if (-not $NoAuth) {
        $parameters.Headers = Get-AuthHeaders -UserId $UserId
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

    $labelUser = if ($NoAuth) { "anonymous" } else { $UserId }
    $passed = $statusCode -eq $ExpectedStatus
    $results.Add([PSCustomObject]@{
        Test = "$Method $Path as $labelUser"
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

# Unauthenticated call must not succeed (JWT required)
Invoke-PocRequest POST "/api/calls" "A1" @{ calleeId = "A2" } 401 -NoAuth | Out-Null

# Spoofable header alone must not authorize (empty Authorization)
try {
    $spoof = Invoke-WebRequest `
        -Method Post `
        -Uri "$ApiUrl/api/calls" `
        -Headers @{ "X-User-Id" = "A1" } `
        -ContentType "application/json" `
        -Body '{"calleeId":"A2"}' `
        -UseBasicParsing
    $spoofStatus = [int]$spoof.StatusCode
}
catch {
    if ($null -eq $_.Exception.Response) { throw }
    $spoofStatus = [int]$_.Exception.Response.StatusCode
}
$spoofPass = $spoofStatus -eq 401
$results.Add([PSCustomObject]@{
    Test = "POST /api/calls with only X-User-Id (no Bearer)"
    Expected = 401
    Actual = $spoofStatus
    Result = if ($spoofPass) { "PASS" } else { "FAIL" }
})
if (-not $spoofPass) {
    throw "Expected spoofed X-User-Id to be rejected with 401, got $spoofStatus"
}

# Cross-clinic create blocked
Invoke-PocRequest POST "/api/calls" "A1" @{ calleeId = "B1" } 403 | Out-Null

$call = Invoke-PocRequest POST "/api/calls" "A1" @{ calleeId = "A2" } 201
$callId = $call.id

# Room must be clinic-namespaced
$expectedRoomPrefix = "clinic:clinic-a:call:"
if (-not $call.roomName.StartsWith($expectedRoomPrefix) -or -not $call.roomName.EndsWith(($callId -replace '-', '').ToLower())) {
    # Guid format N is lowercase hex without dashes
    $idN = ([guid]$callId).ToString("N")
    if ($call.roomName -ne "${expectedRoomPrefix}${idN}") {
        throw "Room name is not clinic-scoped. Expected '${expectedRoomPrefix}${idN}', got '$($call.roomName)'."
    }
}
$results.Add([PSCustomObject]@{
    Test = "LiveKit room clinic namespace"
    Expected = "clinic:clinic-a:call:{id}"
    Actual = $call.roomName
    Result = "PASS"
})

# CallView clinicId present (tenantId may still alias)
$callClinic = $call.clinicId
if ([string]::IsNullOrWhiteSpace($callClinic)) { $callClinic = $call.tenantId }
if ($callClinic -ne 'clinic-a') {
    throw "Call clinicId expected clinic-a, got '$callClinic'."
}

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
if (-not $payload.video.roomJoin -or $payload.video.room -ne $call.roomName -or $payload.sub -ne "clinic-a:A1") {
    throw "LiveKit grants do not match the accepted call. sub=$($payload.sub) room=$($payload.video.room)"
}
$results.Add([PSCustomObject]@{ Test = "LiveKit room/identity grants"; Expected = "scoped"; Actual = "scoped"; Result = "PASS" })

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
    -Headers (Get-AuthHeaders -UserId "A1") `
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

# ---- Phase 1 smoke: agent ready + short queue path (no ring-timeout wait) ----
$ready = Invoke-PocRequest POST "/api/agents/ready" "A1" $null 200
if ($ready.state -ne "Available") {
    throw "A1 ready expected Available, got $($ready.state)"
}
$results.Add([PSCustomObject]@{ Test = "POST /api/agents/ready A1"; Expected = "Available"; Actual = $ready.state; Result = "PASS" })

Invoke-PocRequest POST "/api/agents/ready" "A2" $null 200 | Out-Null

$queueCall = Invoke-PocRequest POST "/api/queue/calls" "VA" $null 201
if ($queueCall.origin -ne "Queue") {
    throw "Queue call origin expected Queue, got $($queueCall.origin)"
}
if ($queueCall.status -ne "Ringing") {
    throw "Queue call with ready staff expected Ringing, got $($queueCall.status)"
}
$queueRoomOk = $queueCall.roomName -like "clinic:clinic-a:call:*"
if (-not $queueRoomOk) {
    throw "Queue room not clinic-scoped: $($queueCall.roomName)"
}
$results.Add([PSCustomObject]@{
    Test = "POST /api/queue/calls VA → Ringing"
    Expected = "Queue+Ringing+clinic room"
    Actual = "$($queueCall.status)/$($queueCall.roomName)"
    Result = "PASS"
})

$assigned = $queueCall.assignedStaffId
if ([string]::IsNullOrWhiteSpace($assigned)) { $assigned = $queueCall.calleeId }
if ($assigned -notin @("A1", "A2", "A3")) {
    throw "Unexpected assigned staff: $assigned"
}

# Non-assigned staff must not accept
$otherStaff = @("A1", "A2", "A3") | Where-Object { $_ -ne $assigned } | Select-Object -First 1
Invoke-PocRequest POST "/api/calls/$($queueCall.id)/accept" $otherStaff $null 403 | Out-Null
Invoke-PocRequest POST "/api/calls/$($queueCall.id)/accept" $assigned $null 200 | Out-Null
Invoke-PocRequest POST "/api/calls/$($queueCall.id)/token" "VA" $null 200 | Out-Null
Invoke-PocRequest POST "/api/calls/$($queueCall.id)/end" $assigned $null 200 | Out-Null
$results.Add([PSCustomObject]@{
    Test = "Queue path accept/token/end"
    Expected = "403 other + 200 assigned"
    Actual = "ok"
    Result = "PASS"
})

# Visitor cannot use direct staff call API
Invoke-PocRequest POST "/api/calls" "VA" @{ calleeId = "A1" } 403 | Out-Null
$results.Add([PSCustomObject]@{
    Test = "Visitor blocked from POST /api/calls"
    Expected = 403
    Actual = 403
    Result = "PASS"
})

$results | Format-Table -AutoSize
if ($results.Result -contains "FAIL") { exit 1 }
Write-Host "Smoke test passed: $($results.Count) checks (JWT + clinic isolation + Phase 1 queue smoke)."
