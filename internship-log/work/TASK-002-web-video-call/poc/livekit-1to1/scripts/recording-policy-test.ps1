<#
.SYNOPSIS
  Phase 3a — recording policy, consent gates, ACL (Staff vs Manager), dispatch exclusion.

.EXAMPLE
  .\scripts\recording-policy-test.ps1 -ApiUrl "http://localhost:5080"
  .\scripts\recording-policy-test.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$DemoPassword = "Demo@123"
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
        [object]$Body = $null
    )
    $headers = @{}
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $params = @{
        Method = $Method
        Uri = "$ApiUrl$Path"
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
        if ($r.Content) { try { $json = $r.Content | ConvertFrom-Json } catch {} }
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

function Get-Login([string]$UserId) {
    $r = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ userId = $UserId; password = $DemoPassword }
    if ($r.Status -ne 200) { throw "login $UserId failed $($r.Status) $($r.Body)" }
    return $r.Json
}

Write-Host "Recording policy / ACL tests against $ApiUrl"

$health = Invoke-Api -Method GET -Path "/health"
Add-Result "Health" ($health.Status -eq 200)

# --- Managers exist ---
$aMgr = Get-Login "A-MGR"
$bMgr = Get-Login "B-MGR"
$a1 = Get-Login "A1"
$a2 = Get-Login "A2"
Add-Result "A-MGR role Manager" ($aMgr.user.role -eq "Manager") "role=$($aMgr.user.role)"
Add-Result "B-MGR role Manager" ($bMgr.user.role -eq "Manager") "role=$($bMgr.user.role)"
Add-Result "A-MGR clinic-a" ($aMgr.user.clinicId -eq "clinic-a") "clinic=$($aMgr.user.clinicId)"
Add-Result "B-MGR clinic-b" ($bMgr.user.clinicId -eq "clinic-b") "clinic=$($bMgr.user.clinicId)"

# --- Policy default None ---
$pol = Invoke-Api -Method GET -Path "/api/clinics/me/recording-policy" -Token $a1.accessToken
Add-Result "policy HTTP 200" ($pol.Status -eq 200) "status=$($pol.Status)"
Add-Result "default mode None" ($pol.Json.defaultMode -eq "None") "mode=$($pol.Json.defaultMode)"
Add-Result "allowed includes AudioOnly" ($pol.Json.allowedModes -contains "AudioOnly") "$($pol.Json.allowedModes -join ',')"
Add-Result "allowed includes Video" ($pol.Json.allowedModes -contains "Video") "$($pol.Json.allowedModes -join ',')"

# Manager can read policy
$polM = Invoke-Api -Method GET -Path "/api/clinics/me/recording-policy" -Token $aMgr.accessToken
Add-Result "Manager reads policy" ($polM.Status -eq 200) "status=$($polM.Status)"

# Visitor cannot read policy
$va = Get-Login "VA"
$polV = Invoke-Api -Method GET -Path "/api/clinics/me/recording-policy" -Token $va.accessToken
Add-Result "Visitor policy 403" ($polV.Status -eq 403) "status=$($polV.Status)"

# --- Ready staff for call ---
$ready1 = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $a1.accessToken
$ready2 = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $a2.accessToken
Add-Result "A1 ready" ($ready1.Status -eq 200)
Add-Result "A2 ready" ($ready2.Status -eq 200)

# Manager ready should 403 (Staff only)
$readyM = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $aMgr.accessToken
Add-Result "Manager agents/ready 403" ($readyM.Status -eq 403) "status=$($readyM.Status)"

# --- Create direct call A1→A2 ---
$create = Invoke-Api -Method POST -Path "/api/calls" -Token $a1.accessToken -Body @{ calleeId = "A2" }
Add-Result "create call" ($create.Status -eq 201) "status=$($create.Status) body=$($create.Body)"
$callId = $create.Json.id
Add-Result "call snapshot mode None" ($create.Json.recordingMode -eq "None") "mode=$($create.Json.recordingMode)"
Add-Result "call consent Pending" ($create.Json.consentStatus -eq "Pending") "consent=$($create.Json.consentStatus)"
# No egress internals on CallView
$props = @($create.Json.PSObject.Properties.Name)
Add-Result "CallView has no recordingEgressId" (-not ($props -contains "recordingEgressId")) "$($props -join ',')"
Add-Result "CallView has no recordingFileName" (-not ($props -contains "recordingFileName")) "$($props -join ',')"

$accept = Invoke-Api -Method POST -Path "/api/calls/$callId/accept" -Token $a2.accessToken
Add-Result "A2 accept" ($accept.Status -eq 200) "status=$($accept.Status)"

# Start with None → conflict
$startNone = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/start" -Token $a1.accessToken
Add-Result "start with None denied" ($startNone.Status -eq 409) "status=$($startNone.Status) body=$($startNone.Body)"

# Mode Video without consent → start denied
$setMode = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/mode" -Token $a1.accessToken -Body @{ mode = "Video" }
Add-Result "set mode Video" ($setMode.Status -eq 200) "status=$($setMode.Status)"
Add-Result "mode snapshot Video" ($setMode.Json.recordingMode -eq "Video") "mode=$($setMode.Json.recordingMode)"

$startNoConsent = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/start" -Token $a1.accessToken
Add-Result "start without consent denied" ($startNoConsent.Status -eq 409) "status=$($startNoConsent.Status) body=$($startNoConsent.Body)"

# Declined → start denied
$decl = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/consent" -Token $a1.accessToken -Body @{ status = "Declined" }
Add-Result "consent Declined" ($decl.Status -eq 200 -and $decl.Json.consentStatus -eq "Declined")
$startDecl = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/start" -Token $a1.accessToken
Add-Result "start after Declined denied" ($startDecl.Status -eq 409) "status=$($startDecl.Status)"

# Granted
$grant = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/consent" -Token $a1.accessToken -Body @{ status = "Granted" }
Add-Result "consent Granted" ($grant.Status -eq 200 -and $grant.Json.consentStatus -eq "Granted")
Add-Result "consent actor set" (-not [string]::IsNullOrWhiteSpace($grant.Json.consentActorId)) "actor=$($grant.Json.consentActorId)"
Add-Result "staff canStart true" ($grant.Json.canStart -eq $true) "canStart=$($grant.Json.canStart)"
Add-Result "staff canDownload false" ($grant.Json.canDownload -eq $false) "canDownload=$($grant.Json.canDownload)"

# Manager view recording — canDownload false until Complete
$mgrView = Invoke-Api -Method GET -Path "/api/calls/$callId/recording" -Token $aMgr.accessToken
Add-Result "Manager GET recording 200" ($mgrView.Status -eq 200) "status=$($mgrView.Status)"
Add-Result "Manager canDownload pre-complete false" ($mgrView.Json.canDownload -eq $false)

# Staff download still 404 (not Manager)
$staffDl = Invoke-Api -Method GET -Path "/api/calls/$callId/recording/file" -Token $a1.accessToken
Add-Result "Staff download 404" ($staffDl.Status -eq 404) "status=$($staffDl.Status)"

# Cross-clinic Manager 404
$bMgrDl = Invoke-Api -Method GET -Path "/api/calls/$callId/recording/file" -Token $bMgr.accessToken
Add-Result "B-MGR download A call 404" ($bMgrDl.Status -eq 404) "status=$($bMgrDl.Status)"

$bMgrRec = Invoke-Api -Method GET -Path "/api/calls/$callId/recording" -Token $bMgr.accessToken
Add-Result "B-MGR GET recording A 404" ($bMgrRec.Status -eq 404) "status=$($bMgrRec.Status)"

# AudioOnly mode set
$setAudio = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/mode" -Token $a1.accessToken -Body @{ mode = "AudioOnly" }
Add-Result "set mode AudioOnly" ($setAudio.Status -eq 200 -and $setAudio.Json.recordingMode -eq "AudioOnly") "mode=$($setAudio.Json.recordingMode)"

# Attempt start — may 503 if no LiveKit egress; gate must not 409 for mode/consent
$startOk = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/start" -Token $a1.accessToken
$gatePassed = $startOk.Status -in @(200, 503)
Add-Result "start after Video/Audio+consent reaches egress (200 or 503)" $gatePassed "status=$($startOk.Status) body=$($startOk.Body)"
if ($startOk.Status -eq 503) {
    $still = Invoke-Api -Method GET -Path "/api/calls/$callId" -Token $a1.accessToken
    Add-Result "call still readable after egress fail" ($still.Status -eq 200) "status=$($still.Status)"
}
if ($startOk.Status -eq 200 -and $startOk.Json.recordingStatus -eq "Recording") {
    $stopTry = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/stop" -Token $a1.accessToken
    # Stop may 503 without file; must not leave Complete without object (I3: call still endable).
    Add-Result "stop after start is 200 or 503" ($stopTry.Status -in @(200, 503)) "status=$($stopTry.Status)"
    if ($stopTry.Status -eq 200) {
        Add-Result "stop Complete only with canDownload for manager path later" ($stopTry.Json.recordingStatus -eq "Complete") "status=$($stopTry.Json.recordingStatus)"
    }
}

# Manager cannot start (not participant)
$mgrStart = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/start" -Token $aMgr.accessToken
Add-Result "Manager start 403 or 404" ($mgrStart.Status -in @(403, 404)) "status=$($mgrStart.Status)"

# End call (must succeed even if recording Failed)
$end = Invoke-Api -Method POST -Path "/api/calls/$callId/end" -Token $a1.accessToken
Add-Result "end call" ($end.Status -eq 200) "status=$($end.Status)"

# --- Manager allow-path: plant Complete object under clinic-scoped key (real storage) ---
$plant = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/plant-complete" -Token $aMgr.accessToken -Body @{ ageDays = 0 }
Add-Result "Manager plant-complete 200" ($plant.Status -eq 200) "status=$($plant.Status) body=$($plant.Body)"
$storageKey = $plant.Json.storageKey
Add-Result "storage key clinic-scoped" ($storageKey -match '^clinic/clinic-a/calls/') "key=$storageKey"
Add-Result "plant canDownload true" ($plant.Json.recording.canDownload -eq $true) "canDownload=$($plant.Json.recording.canDownload)"
Add-Result "plant status Complete" ($plant.Json.recording.recordingStatus -eq "Complete") "status=$($plant.Json.recording.recordingStatus)"

# A-MGR download real bytes
$mgrDl = Invoke-Api -Method GET -Path "/api/calls/$callId/recording/file" -Token $aMgr.accessToken
Add-Result "A-MGR download 200" ($mgrDl.Status -eq 200) "status=$($mgrDl.Status)"
Add-Result "A-MGR download has bytes" ($mgrDl.Body.Length -gt 20) "len=$($mgrDl.Body.Length)"

# Staff / Visitor / cross-clinic Manager still denied after Complete
$staffDl2 = Invoke-Api -Method GET -Path "/api/calls/$callId/recording/file" -Token $a1.accessToken
Add-Result "Staff download after Complete 404" ($staffDl2.Status -eq 404) "status=$($staffDl2.Status)"
$vaDl = Invoke-Api -Method GET -Path "/api/calls/$callId/recording/file" -Token $va.accessToken
Add-Result "Visitor download 403 or 404" ($vaDl.Status -in @(403, 404)) "status=$($vaDl.Status)"
$bMgrDl2 = Invoke-Api -Method GET -Path "/api/calls/$callId/recording/file" -Token $bMgr.accessToken
Add-Result "B-MGR download Complete A 404" ($bMgrDl2.Status -eq 404) "status=$($bMgrDl2.Status)"

# Manager delete + audit
$del = Invoke-Api -Method DELETE -Path "/api/calls/$callId/recording" -Token $aMgr.accessToken
Add-Result "A-MGR delete 200" ($del.Status -eq 200) "status=$($del.Status)"
$del2 = Invoke-Api -Method DELETE -Path "/api/calls/$callId/recording" -Token $aMgr.accessToken
Add-Result "A-MGR delete idempotent 200" ($del2.Status -eq 200) "status=$($del2.Status)"
$audit = Invoke-Api -Method GET -Path "/api/recording/audit" -Token $aMgr.accessToken
Add-Result "audit list Manager" ($audit.Status -eq 200) "status=$($audit.Status)"
$auditActions = @($audit.Json | ForEach-Object { $_.action })
Add-Result "audit has RecordingDownloaded" ($auditActions -contains "RecordingDownloaded") "actions=$($auditActions -join ',')"
Add-Result "audit has RecordingDeleted" ($auditActions -contains "RecordingDeleted") "actions=$($auditActions -join ',')"

# Retention: plant aged Complete then run cleanup
$plantOld = Invoke-Api -Method POST -Path "/api/calls/$callId/recording/plant-complete" -Token $aMgr.accessToken -Body @{ ageDays = 400 }
Add-Result "plant aged Complete" ($plantOld.Status -eq 200 -and $plantOld.Json.recording.recordingStatus -eq "Complete") "status=$($plantOld.Status)"
$ret = Invoke-Api -Method POST -Path "/api/admin/recording/retention-run" -Token $aMgr.accessToken
Add-Result "retention-run Manager" ($ret.Status -eq 200) "status=$($ret.Status) body=$($ret.Body)"
Add-Result "retention deleted >= 1" ([int]$ret.Json.deleted -ge 1) "deleted=$($ret.Json.deleted)"
$afterRet = Invoke-Api -Method GET -Path "/api/calls/$callId/recording" -Token $aMgr.accessToken
Add-Result "after retention status Deleted" ($afterRet.Json.recordingStatus -eq "Deleted") "status=$($afterRet.Json.recordingStatus)"
$audit2 = Invoke-Api -Method GET -Path "/api/recording/audit" -Token $aMgr.accessToken
$auditActions2 = @($audit2.Json | ForEach-Object { $_.action })
Add-Result "audit has RecordingExpired" ($auditActions2 -contains "RecordingExpired") "actions=$($auditActions2 -join ',')"

$retStaff = Invoke-Api -Method POST -Path "/api/admin/recording/retention-run" -Token $a1.accessToken
Add-Result "retention-run Staff 403" ($retStaff.Status -eq 403) "status=$($retStaff.Status)"

# Dispatch exclusion
$agents = Invoke-Api -Method GET -Path "/api/agents" -Token $a1.accessToken
Add-Result "agents snapshot HTTP" ($agents.Status -eq 200)
$rA1 = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $a1.accessToken
$enq = Invoke-Api -Method POST -Path "/api/queue/calls" -Token $va.accessToken
Add-Result "VA enqueue" ($enq.Status -eq 201) "status=$($enq.Status)"
$assigned = $enq.Json.assignedStaffId
if (-not $assigned) { $assigned = $enq.Json.calleeId }
Add-Result "queue not assigned to A-MGR" ($assigned -ne "A-MGR") "assigned=$assigned"
if ($enq.Json.id) {
    $cancel = Invoke-Api -Method POST -Path "/api/calls/$($enq.Json.id)/cancel" -Token $va.accessToken
    Add-Result "cleanup queue call" ($cancel.Status -in @(200, 409)) "status=$($cancel.Status)"
}

$results | Format-Table -AutoSize
$fail = @($results | Where-Object { $_.Result -eq "FAIL" })
if ($fail.Count -gt 0) {
    Write-Host "Recording policy FAILED: $($fail.Count)"
    exit 1
}
Write-Host "Recording policy passed: $($results.Count) checks."
exit 0
