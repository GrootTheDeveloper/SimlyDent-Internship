<#
.SYNOPSIS
  Phase 2 PR-B — embed call ownership, clinic isolation, cancel/end/token rules.

.EXAMPLE
  .\scripts\embed-isolation-test.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
  .\scripts\embed-isolation-test.ps1 -ApiUrl "http://localhost:5080"
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$DemoPassword = "Demo@123",
    [string]$OriginA = "http://127.0.0.1:5174",
    [string]$OriginB = "http://127.0.0.1:5175"
)

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()

function Add-Result([string]$Name, [bool]$Pass, [string]$Detail = "") {
    $results.Add([PSCustomObject]@{
        Test = $Name
        Result = if ($Pass) { "PASS" } else { "FAIL" }
        Detail = $Detail
    })
    if (-not $Pass) { throw "FAIL: $Name — $Detail" }
}

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Path,
        [string]$Token = $null,
        [object]$Body = $null,
        [hashtable]$ExtraHeaders = @{}
    )
    $headers = @{} + $ExtraHeaders
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $uri = "$ApiUrl$Path"
    $params = @{
        Method = $Method
        Uri = $uri
        Headers = $headers
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $params.ContentType = "application/json"
        $params.Body = if ($Body -is [string]) { $Body } else { $Body | ConvertTo-Json -Compress -Depth 6 }
    }
    try {
        $r = Invoke-WebRequest @params
        $json = $null
        if ($r.Content) {
            try { $json = $r.Content | ConvertFrom-Json } catch {}
        }
        return @{ Status = [int]$r.StatusCode; Json = $json; Body = $r.Content }
    }
    catch {
        if ($null -eq $_.Exception.Response) { throw }
        $status = [int]$_.Exception.Response.StatusCode
        $reader = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        try { $content = $reader.ReadToEnd() } finally { $reader.Dispose() }
        $json = $null
        try { if ($content) { $json = $content | ConvertFrom-Json } } catch {}
        return @{ Status = $status; Json = $json; Body = $content }
    }
}

function New-EmbedSession([string]$SiteKey, [string]$Origin) {
    $r = Invoke-Api -Method POST -Path "/embed/session" -Body @{ siteKey = $SiteKey } `
        -ExtraHeaders @{ Origin = $Origin }
    if ($r.Status -ne 200) { throw "embed session failed status=$($r.Status) body=$($r.Body)" }
    return $r.Json
}

Write-Host "Embed isolation tests against $ApiUrl"
Write-Host "OriginA=$OriginA OriginB=$OriginB"

$health = Invoke-Api -Method GET -Path "/health"
Add-Result "Health" ($health.Status -eq 200)

# Sessions
$sessA1 = New-EmbedSession "pk_clinic_a" $OriginA
$sessA2 = New-EmbedSession "pk_clinic_a" $OriginA
$sessB = New-EmbedSession "pk_clinic_b" $OriginB
$tokA1 = $sessA1.accessToken
$tokA2 = $sessA2.accessToken
$tokB = $sessB.accessToken
Add-Result "two clinic-a sessions" (
    $sessA1.sessionId -ne $sessA2.sessionId -and $sessA1.clinicId -eq "clinic-a"
) "s1=$($sessA1.sessionId) s2=$($sessA2.sessionId)"

# Staff token
$login = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ userId = "A1"; password = $DemoPassword }
Add-Result "staff A1 login" ($login.Status -eq 200) "status=$($login.Status)"
$staffTok = $login.Json.accessToken
$null = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $staffTok

# Staff JWT cannot use embed call API
$staffOnEmbed = Invoke-Api -Method POST -Path "/embed/calls" -Token $staffTok
Add-Result "staff JWT rejected on POST /embed/calls" ($staffOnEmbed.Status -in @(401, 403)) "status=$($staffOnEmbed.Status)"

# No token
$anon = Invoke-Api -Method POST -Path "/embed/calls"
Add-Result "anonymous POST /embed/calls 401" ($anon.Status -eq 401) "status=$($anon.Status)"

# Create call clinic A session 1
$create = Invoke-Api -Method POST -Path "/embed/calls" -Token $tokA1
Add-Result "POST /embed/calls 201/200" ($create.Status -in @(200, 201)) "status=$($create.Status)"
$callId = [Guid]$create.Json.id
Add-Result "embed call has id" ($null -ne $callId -and $callId -ne [Guid]::Empty) "id=$callId"
Add-Result "status Queued or Ringing" ($create.Json.status -in @("Queued", "Ringing")) "status=$($create.Json.status)"
Add-Result "EmbedCallView no roomName" ($null -eq $create.Json.roomName -or $create.Json.PSObject.Properties.Name -notcontains "roomName") "props=$($create.Json.PSObject.Properties.Name -join ',')"
Add-Result "EmbedCallView no assignedStaff" ($null -eq $create.Json.assignedStaffId) "ok"
Add-Result "EmbedCallView has waitingSeconds" ($null -ne $create.Json.waitingSeconds) "w=$($create.Json.waitingSeconds)"

# Idempotent create (same session)
$create2 = Invoke-Api -Method POST -Path "/embed/calls" -Token $tokA1
Add-Result "same session reuses active call" (
    $create2.Status -in @(200, 201) -and [Guid]$create2.Json.id -eq $callId
) "id2=$($create2.Json.id)"

# GET own call
$get = Invoke-Api -Method GET -Path "/embed/calls/$callId" -Token $tokA1
Add-Result "GET own call" ($get.Status -eq 200 -and [Guid]$get.Json.id -eq $callId) "status=$($get.Status)"

# Same clinic, different session cannot read
$otherSess = Invoke-Api -Method GET -Path "/embed/calls/$callId" -Token $tokA2
Add-Result "same clinic other session 404" ($otherSess.Status -eq 404) "status=$($otherSess.Status)"

# Cross clinic B cannot read A call
$cross = Invoke-Api -Method GET -Path "/embed/calls/$callId" -Token $tokB
Add-Result "clinic-b cannot read clinic-a call 404" ($cross.Status -eq 404) "status=$($cross.Status)"

# Token before accept → 409
$tokEarly = Invoke-Api -Method POST -Path "/embed/calls/$callId/token" -Token $tokA1
Add-Result "token before accept 409" ($tokEarly.Status -eq 409) "status=$($tokEarly.Status)"

# End before accept → 409
$endEarly = Invoke-Api -Method POST -Path "/embed/calls/$callId/end" -Token $tokA1
Add-Result "end before accept 409" ($endEarly.Status -eq 409) "status=$($endEarly.Status)"

# Wait briefly for dispatch to A1 (if available) — optional path
Start-Sleep -Seconds 1
$poll = Invoke-Api -Method GET -Path "/embed/calls/$callId" -Token $tokA1
$statusBeforeCancel = $poll.Json.status

if ($statusBeforeCancel -eq "Ringing" -or $statusBeforeCancel -eq "Queued") {
    # Cancel works in Queued/Ringing
    $cancel = Invoke-Api -Method POST -Path "/embed/calls/$callId/cancel" -Token $tokA1
    Add-Result "visitor cancel Queued/Ringing" (
        $cancel.Status -eq 200 -and $cancel.Json.status -eq "Cancelled"
    ) "status=$($cancel.Status) body=$($cancel.Json.status)"

    # Idempotent cancel
    $cancel2 = Invoke-Api -Method POST -Path "/embed/calls/$callId/cancel" -Token $tokA1
    Add-Result "cancel idempotent" ($cancel2.Status -eq 200 -and $cancel2.Json.status -eq "Cancelled") "status=$($cancel2.Status)"
} else {
    Add-Result "cancel path skipped (unexpected status)" $true "status=$statusBeforeCancel"
}

# Full happy path: create → staff accept → token → end
$sessHappy = New-EmbedSession "pk_clinic_a" $OriginA
$tokHappy = $sessHappy.accessToken
$created = Invoke-Api -Method POST -Path "/embed/calls" -Token $tokHappy
Add-Result "happy create" ($created.Status -in @(200, 201)) "status=$($created.Status)"
$happyId = [Guid]$created.Json.id

# Ensure A1 ready and wait for Ringing
$null = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $staffTok
$ringing = $false
for ($i = 0; $i -lt 20; $i++) {
    $p = Invoke-Api -Method GET -Path "/embed/calls/$happyId" -Token $tokHappy
    if ($p.Json.status -eq "Ringing") { $ringing = $true; break }
    if ($p.Json.status -eq "Accepted") { $ringing = $true; break }
    Start-Sleep -Milliseconds 500
}
Add-Result "dispatched to Ringing (or Accepted)" $ringing "last=$($p.Json.status)"

if ($p.Json.status -ne "Accepted") {
    $acc = Invoke-Api -Method POST -Path "/api/calls/$happyId/accept" -Token $staffTok
    Add-Result "staff accept" ($acc.Status -eq 200 -and $acc.Json.status -eq "Accepted") "status=$($acc.Status) body=$($acc.Body)"
} else {
    Add-Result "staff accept already done" $true
}

$accepted = Invoke-Api -Method GET -Path "/embed/calls/$happyId" -Token $tokHappy
Add-Result "visitor sees Accepted" ($accepted.Json.status -eq "Accepted") "status=$($accepted.Json.status)"

# Cancel after accept → 409
$cancelAfter = Invoke-Api -Method POST -Path "/embed/calls/$happyId/cancel" -Token $tokHappy
Add-Result "cancel after accept 409" ($cancelAfter.Status -eq 409) "status=$($cancelAfter.Status)"

# Media token after accept
$media = Invoke-Api -Method POST -Path "/embed/calls/$happyId/token" -Token $tokHappy
Add-Result "token after accept" ($media.Status -eq 200 -and $media.Json.token) "status=$($media.Status)"
Add-Result "token has url" (-not [string]::IsNullOrWhiteSpace($media.Json.url)) "url=$($media.Json.url)"

# Other session cannot get token
$tokOther = Invoke-Api -Method POST -Path "/embed/calls/$happyId/token" -Token $tokA2
Add-Result "other session token 404" ($tokOther.Status -eq 404) "status=$($tokOther.Status)"

# Clinic B cannot get token
$tokCross = Invoke-Api -Method POST -Path "/embed/calls/$happyId/token" -Token $tokB
Add-Result "clinic-b token 404" ($tokCross.Status -eq 404) "status=$($tokCross.Status)"

# Visitor end after accept
$ended = Invoke-Api -Method POST -Path "/embed/calls/$happyId/end" -Token $tokHappy
Add-Result "visitor end after accept" ($ended.Status -eq 200 -and $ended.Json.status -eq "Ended") "status=$($ended.Status) s=$($ended.Json.status)"

# Idempotent end
$ended2 = Invoke-Api -Method POST -Path "/embed/calls/$happyId/end" -Token $tokHappy
Add-Result "end idempotent" ($ended2.Status -eq 200 -and $ended2.Json.status -eq "Ended") "status=$($ended2.Status)"

# Clinic B can create its own call without seeing A
$createB = Invoke-Api -Method POST -Path "/embed/calls" -Token $tokB
Add-Result "clinic-b create call" ($createB.Status -in @(200, 201)) "status=$($createB.Status)"
$callB = [Guid]$createB.Json.id
$getBfromA = Invoke-Api -Method GET -Path "/embed/calls/$callB" -Token $tokA1
Add-Result "clinic-a cannot read clinic-b call 404" ($getBfromA.Status -eq 404) "status=$($getBfromA.Status)"
$cancelB = Invoke-Api -Method POST -Path "/embed/calls/$callB/cancel" -Token $tokB
Add-Result "clinic-b cancel own" ($cancelB.Status -eq 200) "status=$($cancelB.Status)"

# Embed JWT cannot use staff queue overview
$embedOnStaff = Invoke-Api -Method GET -Path "/api/queue" -Token $tokHappy
Add-Result "embed token cannot GET /api/queue" ($embedOnStaff.Status -in @(401, 403)) "status=$($embedOnStaff.Status)"

$results | Format-Table -AutoSize
$fail = @($results | Where-Object { $_.Result -eq "FAIL" })
if ($fail.Count -gt 0) {
    Write-Host "Embed isolation FAILED: $($fail.Count)"
    exit 1
}
Write-Host "Embed isolation passed: $($results.Count) checks."
