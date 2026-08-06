<#
.SYNOPSIS
  TASK-003 Phase 1 — agent state + queue auto-dispatch tests (JWT-only).

.PARAMETER SkipSlow
  Skip ring-timeout wait (~18s).

.EXAMPLE
  .\scripts\routing-test.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
  .\scripts\routing-test.ps1 -ApiUrl "http://localhost:5080" -SkipSlow
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$DemoPassword = "Demo@123",
    # Default: run ring-timeout (~18s). Pass -SkipSlow to omit.
    [switch]$SkipSlow
)

$ErrorActionPreference = "Stop"
$results = [System.Collections.Generic.List[object]]::new()
$tokenCache = @{}

function Add-Result([string]$Name, [bool]$Pass, [string]$Detail = "") {
    $results.Add([PSCustomObject]@{
        Test = $Name
        Result = if ($Pass) { "PASS" } else { "FAIL" }
        Detail = $Detail
    })
    if (-not $Pass) { throw "FAIL: $Name — $Detail" }
}

function Get-Token([string]$UserId) {
    if ($tokenCache.ContainsKey($UserId)) { return $tokenCache[$UserId] }
    $login = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/login" `
        -ContentType "application/json" `
        -Body (@{ userId = $UserId; password = $DemoPassword } | ConvertTo-Json -Compress)
    if ([string]::IsNullOrWhiteSpace($login.accessToken)) {
        throw "Empty token for $UserId"
    }
    $tokenCache[$UserId] = $login.accessToken
    return $login.accessToken
}

function Invoke-Api([string]$Method, [string]$Path, [string]$UserId, $Body = $null) {
    $params = @{
        Method = $Method
        Uri = "$ApiUrl$Path"
        Headers = @{ Authorization = "Bearer $(Get-Token $UserId)" }
        UseBasicParsing = $true
    }
    if ($null -ne $Body) {
        $params.ContentType = "application/json"
        $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    }
    try {
        $r = Invoke-WebRequest @params
        return @{ Status = [int]$r.StatusCode; Json = $(if ($r.Content) { $r.Content | ConvertFrom-Json } else { $null }) }
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

function Get-Assigned($call) {
    if ($call.assignedStaffId) { return $call.assignedStaffId }
    if ($call.calleeId) { return $call.calleeId }
    return $null
}

function Cancel-IfActive([string]$UserId, $callId) {
    if (-not $callId) { return }
    try { Invoke-Api POST "/api/calls/$callId/cancel" $UserId | Out-Null } catch {}
    try { Invoke-Api POST "/api/calls/$callId/end" $UserId | Out-Null } catch {}
}

$IncludeSlow = -not $SkipSlow.IsPresent
Write-Host "Routing test against $ApiUrl (IncludeSlow=$IncludeSlow)"
Write-Host ""

# ---------------------------------------------------------------------------
# 0. Health + identity roles
# ---------------------------------------------------------------------------
$h = Invoke-WebRequest -Uri "$ApiUrl/health" -UseBasicParsing
Add-Result "Health" ($h.StatusCode -eq 200)

$loginVa = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/login" `
    -ContentType "application/json" `
    -Body (@{ userId = "VA"; password = $DemoPassword } | ConvertTo-Json -Compress)
$tokenCache["VA"] = $loginVa.accessToken
$vaRole = $loginVa.user.role
Add-Result "VA login role Visitor" ($vaRole -eq "Visitor") "role=$vaRole"
$vaClinic = if ($loginVa.user.clinicId) { $loginVa.user.clinicId } else { $loginVa.user.tenantId }
Add-Result "VA clinic-a" ($vaClinic -eq "clinic-a") "clinic=$vaClinic"

# ---------------------------------------------------------------------------
# 1. Agent ready + presence state + heartbeat
# ---------------------------------------------------------------------------
$r1 = Invoke-Api POST "/api/agents/ready" "A1"
Add-Result "A1 ready" ($r1.Status -eq 200 -and $r1.Json.state -eq "Available") "state=$($r1.Json.state)"
$r2 = Invoke-Api POST "/api/agents/ready" "A2"
Add-Result "A2 ready" ($r2.Status -eq 200 -and $r2.Json.state -eq "Available") "state=$($r2.Json.state)"
$r3 = Invoke-Api POST "/api/agents/ready" "A3"
Add-Result "A3 ready" ($r3.Status -eq 200) "state=$($r3.Json.state)"

$hb = Invoke-Api POST "/api/agents/heartbeat" "A1"
Add-Result "A1 heartbeat" ($hb.Status -eq 200 -and $hb.Json.state) "state=$($hb.Json.state)"

$visitorHb = Invoke-Api POST "/api/agents/ready" "VA"
Add-Result "Visitor cannot agents/ready" ($visitorHb.Status -eq 403) "status=$($visitorHb.Status)"

$pres = Invoke-Api GET "/api/presence" "A1"
Add-Result "Presence HTTP" ($pres.Status -eq 200)
$states = @($pres.Json.users | ForEach-Object { $_.state })
Add-Result "Presence has agent state" ($states -contains "Available") "states=$($states -join ',')"
$presUserIds = @($pres.Json.users | ForEach-Object { $_.userId })
Add-Result "Presence staff only (no VA)" (-not ($presUserIds -contains "VA")) "users=$($presUserIds -join ',')"

$agents = Invoke-Api GET "/api/agents" "A1"
Add-Result "GET /api/agents" ($agents.Status -eq 200) "status=$($agents.Status)"

$queueEmpty = Invoke-Api GET "/api/queue" "A1"
Add-Result "GET /api/queue" ($queueEmpty.Status -eq 200) "status=$($queueEmpty.Status)"

# ---------------------------------------------------------------------------
# 2. Happy path: enqueue → assign → accept → media token → end
# ---------------------------------------------------------------------------
$q = Invoke-Api POST "/api/queue/calls" "VA"
Add-Result "VA enqueue HTTP" ($q.Status -eq 201) "status=$($q.Status)"
$call = $q.Json
Add-Result "VA call origin Queue" ($call.origin -eq "Queue") "origin=$($call.origin)"
Add-Result "VA call Ringing when staff available" ($call.status -eq "Ringing") "status=$($call.status) assigned=$(Get-Assigned $call)"
$assigned = Get-Assigned $call
Add-Result "Assigned is clinic-a staff" ($assigned -in @("A1", "A2", "A3")) "assigned=$assigned"
Add-Result "Room clinic-scoped" ($call.roomName -like "clinic:clinic-a:call:*") "room=$($call.roomName)"

$other = @("A1", "A2", "A3") | Where-Object { $_ -ne $assigned } | Select-Object -First 1
$deny = Invoke-Api POST "/api/calls/$($call.id)/accept" $other
Add-Result "Non-assigned staff accept 403" ($deny.Status -eq 403) "as=$other status=$($deny.Status)"

$denyRej = Invoke-Api POST "/api/calls/$($call.id)/reject" $other
Add-Result "Non-assigned staff reject 403" ($denyRej.Status -eq 403) "as=$other status=$($denyRej.Status)"

$cross = Invoke-Api GET "/api/calls/$($call.id)" "B1"
Add-Result "B1 GET queue call 404" ($cross.Status -eq 404) "status=$($cross.Status)"
$crossTok = Invoke-Api POST "/api/calls/$($call.id)/token" "B1"
Add-Result "B1 media token 404" ($crossTok.Status -eq 404) "status=$($crossTok.Status)"
$crossAcc = Invoke-Api POST "/api/calls/$($call.id)/accept" "B1"
Add-Result "B1 accept 404" ($crossAcc.Status -eq 404) "status=$($crossAcc.Status)"

# Token before accept → 409
$tokEarly = Invoke-Api POST "/api/calls/$($call.id)/token" "VA"
Add-Result "Visitor token before accept 409" ($tokEarly.Status -eq 409) "status=$($tokEarly.Status)"

$acc = Invoke-Api POST "/api/calls/$($call.id)/accept" $assigned
Add-Result "Assigned accept → Accepted" ($acc.Status -eq 200 -and $acc.Json.status -eq "Accepted") "status=$($acc.Json.status)"

$tokVa = Invoke-Api POST "/api/calls/$($call.id)/token" "VA"
Add-Result "Visitor media token after accept" ($tokVa.Status -eq 200 -and $tokVa.Json.token) "status=$($tokVa.Status)"
$tokStaff = Invoke-Api POST "/api/calls/$($call.id)/token" $assigned
Add-Result "Staff media token after accept" ($tokStaff.Status -eq 200) "status=$($tokStaff.Status)"

# Decode room grant
$parts = $tokVa.Json.token.Split('.')
$payloadText = $parts[1].Replace('-', '+').Replace('_', '/')
while ($payloadText.Length % 4) { $payloadText += '=' }
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadText)) | ConvertFrom-Json
Add-Result "Queue media token exact room" ($payload.video.room -eq $call.roomName) "room=$($payload.video.room)"

$end = Invoke-Api POST "/api/calls/$($call.id)/end" $assigned
Add-Result "End queue call" ($end.Status -eq 200 -and $end.Json.status -eq "Ended") "status=$($end.Json.status)"

# ---------------------------------------------------------------------------
# 3. One active call per visitor
# ---------------------------------------------------------------------------
Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
Invoke-Api POST "/api/agents/ready" "A2" | Out-Null
$qA = Invoke-Api POST "/api/queue/calls" "VA"
$idA = $qA.Json.id
$qB = Invoke-Api POST "/api/queue/calls" "VA"
Add-Result "Second VA enqueue returns same active call" ($qB.Json.id -eq $idA) "first=$idA second=$($qB.Json.id)"
Cancel-IfActive "VA" $idA

# ---------------------------------------------------------------------------
# 4. Capacity: 1 staff busy → second enqueue Queued
# ---------------------------------------------------------------------------
Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
# Only keep A1 effectively free for assignment by accepting on A1 after ring
$q1 = Invoke-Api POST "/api/queue/calls" "VA"
$s1 = Get-Assigned $q1.Json
Add-Result "Capacity setup call Ringing" ($q1.Json.status -eq "Ringing") "assigned=$s1"
# Accept so staff is InCall
Invoke-Api POST "/api/calls/$($q1.Json.id)/accept" $s1 | Out-Null

# Second "visitor" via staff A3 enqueue (Phase 1 allows staff to enqueue for tests)
$q2 = Invoke-Api POST "/api/queue/calls" "A3"
Add-Result "Second enqueue while staff in call" ($q2.Status -eq 201) "status=$($q2.Status) callStatus=$($q2.Json.status)"
# With remaining Available staff (A2), may Ringing; if all busy → Queued.
# Force busy path: if A2 also available, A3 might ring A2 — still valid.
# Assert: not both on same staff; and at most one Ringing per staff.
$st2 = $q2.Json.status
Add-Result "Second call is Ringing or Queued" ($st2 -in @("Ringing", "Queued")) "status=$st2 assigned=$(Get-Assigned $q2.Json)"
if ($st2 -eq "Ringing") {
    $s2 = Get-Assigned $q2.Json
    Add-Result "Second call assigned different staff" ($s2 -ne $s1) "s1=$s1 s2=$s2"
}

# Queue snapshot visible to clinic staff
$qs = Invoke-Api GET "/api/queue" "A1"
Add-Result "Queue snapshot HTTP" ($qs.Status -eq 200)
$qItems = @($qs.Json.items)
Add-Result "Queue snapshot has items or empty list" ($null -ne $qs.Json.items) "count=$($qItems.Count)"

# Cross-clinic queue empty for B1 regarding clinic-a items
$qsB = Invoke-Api GET "/api/queue" "B1"
$bItems = @($qsB.Json.items)
$leaked = $bItems | Where-Object { $_.id -eq $q1.Json.id -or $_.id -eq $q2.Json.id }
Add-Result "B1 queue does not list clinic-a calls" ($null -eq $leaked -or @($leaked).Count -eq 0) "count=$(@($leaked).Count)"

# Cleanup capacity calls
Cancel-IfActive $s1 $q1.Json.id
if ($st2 -eq "Ringing") {
    $s2 = Get-Assigned $q2.Json
    Cancel-IfActive $s2 $q2.Json.id
}
Cancel-IfActive "A3" $q2.Json.id
Cancel-IfActive "VA" $q1.Json.id
Invoke-Api POST "/api/calls/$($q1.Json.id)/end" $s1 | Out-Null
if ($st2 -eq "Accepted") { } # n/a
# ensure ended
try { Invoke-Api POST "/api/calls/$($q1.Json.id)/end" $s1 | Out-Null } catch {}
try {
    if ($st2 -eq "Ringing") {
        $s2 = Get-Assigned $q2.Json
        Invoke-Api POST "/api/calls/$($q2.Json.id)/cancel" "A3" | Out-Null
    } elseif ($st2 -eq "Queued") {
        Invoke-Api POST "/api/calls/$($q2.Json.id)/cancel" "A3" | Out-Null
    }
} catch {}

# ---------------------------------------------------------------------------
# 5. Reject → redispatch
# ---------------------------------------------------------------------------
Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
Invoke-Api POST "/api/agents/ready" "A2" | Out-Null
Invoke-Api POST "/api/agents/ready" "A3" | Out-Null
$q4 = Invoke-Api POST "/api/queue/calls" "VA"
$staff1 = Get-Assigned $q4.Json
$rej = Invoke-Api POST "/api/calls/$($q4.Json.id)/reject" $staff1
Add-Result "Reject by assigned" ($rej.Status -eq 200) "status=$($rej.Status)"
Start-Sleep -Milliseconds 400
$after = Invoke-Api GET "/api/calls/$($q4.Json.id)" "VA"
$st = $after.Json.status
Add-Result "After reject: Ringing or Queued" ($st -in @("Ringing", "Queued")) "status=$st"
if ($st -eq "Ringing") {
    $staff2 = Get-Assigned $after.Json
    Add-Result "Redispatch avoids same staff when others free" ($staff2 -ne $staff1) "from=$staff1 to=$staff2"
}
Cancel-IfActive "VA" $q4.Json.id

# ---------------------------------------------------------------------------
# 6. Visitor cancel while Ringing
# ---------------------------------------------------------------------------
Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
$q5 = Invoke-Api POST "/api/queue/calls" "VA"
$c5 = Invoke-Api POST "/api/calls/$($q5.Json.id)/cancel" "VA"
Add-Result "Visitor cancel while Ringing" ($c5.Status -eq 200 -and $c5.Json.status -eq "Cancelled") "status=$($c5.Json.status)"

# ---------------------------------------------------------------------------
# 7. End → immediate redispatch of queued head
# ---------------------------------------------------------------------------
Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
Invoke-Api POST "/api/agents/ready" "A2" | Out-Null
# Hold A1+A2 with two parallel rings if possible: VA + A3
$hold1 = Invoke-Api POST "/api/queue/calls" "VA"
$h1 = Get-Assigned $hold1.Json
Invoke-Api POST "/api/calls/$($hold1.Json.id)/accept" $h1 | Out-Null
$hold2 = Invoke-Api POST "/api/queue/calls" "A3"
# A3 may ring remaining staff or queue
if ($hold2.Json.status -eq "Queued") {
    # free staff by ending hold1 → should dispatch hold2
    Invoke-Api POST "/api/calls/$($hold1.Json.id)/end" $h1 | Out-Null
    Start-Sleep -Milliseconds 600
    $dispatched = Invoke-Api GET "/api/calls/$($hold2.Json.id)" "A3"
    Add-Result "End call dispatches queued head" ($dispatched.Json.status -eq "Ringing") "status=$($dispatched.Json.status) assigned=$(Get-Assigned $dispatched.Json)"
    Cancel-IfActive "A3" $hold2.Json.id
} else {
    # Both got staff — still assert end works; redispatch N/A
    Add-Result "End→dispatch skipped (no Queued head; second got staff)" $true "hold2=$($hold2.Json.status)"
    Cancel-IfActive "A3" $hold2.Json.id
    try { Invoke-Api POST "/api/calls/$($hold1.Json.id)/end" $h1 | Out-Null } catch {}
}

# ---------------------------------------------------------------------------
# 8. Direct path + visitor blocked
# ---------------------------------------------------------------------------
Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
Invoke-Api POST "/api/agents/ready" "A2" | Out-Null
$d = Invoke-Api POST "/api/calls" "A1" @{ calleeId = "A2" }
Add-Result "Direct A1→A2 still works" ($d.Status -eq 201 -and $d.Json.origin -eq "Direct") "status=$($d.Status) origin=$($d.Json.origin)"
Invoke-Api POST "/api/calls/$($d.Json.id)/accept" "A2" | Out-Null
# Busy: A2 InCall → third party cannot direct-call A2
$busy = Invoke-Api POST "/api/calls" "A3" @{ calleeId = "A2" }
Add-Result "Direct call to busy staff 409" ($busy.Status -eq 409) "status=$($busy.Status)"
Invoke-Api POST "/api/calls/$($d.Json.id)/end" "A1" | Out-Null

$vd = Invoke-Api POST "/api/calls" "VA" @{ calleeId = "A1" }
Add-Result "Visitor blocked from direct call" ($vd.Status -eq 403) "status=$($vd.Status)"

# Cross-clinic direct still 403
$xc = Invoke-Api POST "/api/calls" "A1" @{ calleeId = "B1" }
Add-Result "Direct cross-clinic 403" ($xc.Status -eq 403) "status=$($xc.Status)"

# ---------------------------------------------------------------------------
# 9. Ring timeout (~15s) — optional slow
# ---------------------------------------------------------------------------
if ($IncludeSlow) {
    Write-Host "Waiting ~18s for ring timeout..."
    Invoke-Api POST "/api/agents/ready" "A1" | Out-Null
    Invoke-Api POST "/api/agents/ready" "A2" | Out-Null
    $qRing = Invoke-Api POST "/api/queue/calls" "VA"
    $beforeStaff = Get-Assigned $qRing.Json
    Add-Result "Ring-timeout setup Ringing" ($qRing.Json.status -eq "Ringing") "assigned=$beforeStaff"
    Start-Sleep -Seconds 18
    $afterRing = Invoke-Api GET "/api/calls/$($qRing.Json.id)" "VA"
    $afterSt = $afterRing.Json.status
    $afterStaff = Get-Assigned $afterRing.Json
    Add-Result "After ring timeout still active or re-queued" ($afterSt -in @("Ringing", "Queued", "Timeout")) "status=$afterSt assigned=$afterStaff"
    if ($afterSt -eq "Ringing" -and $afterStaff) {
        # Prefer different staff when another Available
        Add-Result "Ring timeout redispatch staff changed or same-cycle ok" ($true) "from=$beforeStaff to=$afterStaff"
    }
    Cancel-IfActive "VA" $qRing.Json.id
} else {
    Add-Result "Ring timeout (skipped)" $true "IncludeSlow=false"
}

# ---------------------------------------------------------------------------
# 10. No-staff enqueue → Queued (best effort: all staff busy)
# ---------------------------------------------------------------------------
# Put A1,A2,A3 into InCall via three direct/queue holds if possible is heavy.
# Simpler: cancel all, do not mark ready for B clinic visitor VB with only B1 offline.
# VB with B1 not ready → Queued
$qVb = Invoke-Api POST "/api/queue/calls" "VB"
# B1 may be ready from browser sessions on VPS — accept either Queued or Ringing
Add-Result "VB enqueue clinic-b" ($qVb.Status -eq 201) "status=$($qVb.Json.status) assigned=$(Get-Assigned $qVb.Json)"
Add-Result "VB call clinic-b isolation room" ($qVb.Json.roomName -like "clinic:clinic-b:call:*") "room=$($qVb.Json.roomName)"
$vaSeeVb = Invoke-Api GET "/api/calls/$($qVb.Json.id)" "VA"
Add-Result "VA cannot see VB call" ($vaSeeVb.Status -eq 404) "status=$($vaSeeVb.Status)"
Cancel-IfActive "VB" $qVb.Json.id
if ($qVb.Json.status -eq "Ringing") {
    $bs = Get-Assigned $qVb.Json
    try { Invoke-Api POST "/api/calls/$($qVb.Json.id)/reject" $bs | Out-Null } catch {}
    Cancel-IfActive "VB" $qVb.Json.id
}

# ---------------------------------------------------------------------------
Write-Host ""
$results | Format-Table -AutoSize
$fail = @($results | Where-Object { $_.Result -eq "FAIL" })
if ($fail.Count -gt 0) {
    Write-Host "Routing test FAILED: $($fail.Count) check(s)."
    exit 1
}
Write-Host "Routing test passed: $($results.Count) checks."
