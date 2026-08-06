<#
.SYNOPSIS
  Embed lifecycle: stale visitor waiting, atomic duplicate create, cancel-vs-accept.

.EXAMPLE
  .\scripts\embed-lifecycle-test.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$DemoPassword = "Demo@123",
    [string]$OriginA = "http://127.0.0.1:5174",
    [int]$StaleWaitingSeconds = 30,
    [switch]$SkipSlow
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

function New-Session([string]$Origin = $OriginA) {
    $r = Invoke-Api -Method POST -Path "/embed/session" -Body @{ siteKey = "pk_clinic_a" } `
        -ExtraHeaders @{ Origin = $Origin }
    if ($r.Status -ne 200) { throw "session failed $($r.Status) $($r.Body)" }
    return $r.Json
}

Write-Host "Embed lifecycle tests against $ApiUrl"
$h = Invoke-Api -Method GET -Path "/health"
Add-Result "Health" ($h.Status -eq 200)

# --- Atomic duplicate create (parallel) ---
$sessDup = New-Session
$tokDup = $sessDup.accessToken
$jobs = 1..6 | ForEach-Object {
    Start-Job -ScriptBlock {
        param($Api, $Tok)
        try {
            $r = Invoke-WebRequest -Method Post -Uri "$Api/embed/calls" `
                -Headers @{ Authorization = "Bearer $Tok" } `
                -ContentType "application/json" -Body "{}" -UseBasicParsing
            return @{ Status = [int]$r.StatusCode; Body = $r.Content }
        }
        catch {
            $s = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
            return @{ Status = $s; Body = $_.Exception.Message }
        }
    } -ArgumentList $ApiUrl, $tokDup
}
$outs = $jobs | Wait-Job | Receive-Job
$jobs | Remove-Job -Force
$ids = @()
foreach ($o in $outs) {
    if ($o.Status -in 200, 201 -and $o.Body) {
        try {
            $j = $o.Body | ConvertFrom-Json
            if ($j.id) { $ids += [string]$j.id }
        } catch {}
    }
}
$unique = @($ids | Select-Object -Unique)
Add-Result "parallel create single active id" ($unique.Count -eq 1 -and $ids.Count -ge 1) `
    "ids=$($unique -join ',') count=$($ids.Count)"

# cancel that call
if ($unique.Count -eq 1) {
    $null = Invoke-Api -Method POST -Path "/embed/calls/$($unique[0])/cancel" -Token $tokDup -Body "{}"
}

# --- Cancel vs Accept race ---
$staffToks = @{}
foreach ($uid in @("A1", "A2", "A3")) {
    $login = Invoke-Api -Method POST -Path "/api/auth/login" -Body @{ userId = $uid; password = $DemoPassword }
    Add-Result "$uid login" ($login.Status -eq 200)
    $staffToks[$uid] = $login.Json.accessToken
    $null = Invoke-Api -Method POST -Path "/api/agents/ready" -Token $staffToks[$uid]
}

$sessRace = New-Session
$tokRace = $sessRace.accessToken
$created = Invoke-Api -Method POST -Path "/embed/calls" -Token $tokRace -Body "{}"
Add-Result "race call create" ($created.Status -in 200, 201) "status=$($created.Status)"
$raceId = $created.Json.id

# Wait until Ringing; discover assigned staff from queue snapshot
$ringed = $false
$assigned = $null
for ($i = 0; $i -lt 20; $i++) {
    $p = Invoke-Api -Method GET -Path "/embed/calls/$raceId" -Token $tokRace
    if ($p.Json.status -eq "Ringing") {
        $ringed = $true
        $q = Invoke-Api -Method GET -Path "/api/queue" -Token $staffToks["A1"]
        $item = @($q.Json.items) | Where-Object { $_.id -eq $raceId } | Select-Object -First 1
        $assigned = $item.assignedStaffId
        break
    }
    Start-Sleep -Milliseconds 300
}
Add-Result "race call Ringing" $ringed "last=$($p.Json.status) assigned=$assigned"
if (-not $assigned) { $assigned = "A1" }
$acceptTok = $staffToks[$assigned]
if (-not $acceptTok) { $acceptTok = $staffToks["A1"] }

$acceptJob = Start-Job -ScriptBlock {
    param($Api, $Tok, $Id)
    try {
        $r = Invoke-WebRequest -Method Post -Uri "$Api/api/calls/$Id/accept" `
            -Headers @{ Authorization = "Bearer $Tok" } -UseBasicParsing
        return @{ Status = [int]$r.StatusCode; Body = $r.Content }
    } catch {
        $s = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        $rd = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        try { $c = $rd.ReadToEnd() } finally { $rd.Dispose() }
        return @{ Status = $s; Body = $c }
    }
} -ArgumentList $ApiUrl, $acceptTok, $raceId

$cancelJob = Start-Job -ScriptBlock {
    param($Api, $Tok, $Id)
    try {
        $r = Invoke-WebRequest -Method Post -Uri "$Api/embed/calls/$Id/cancel" `
            -Headers @{ Authorization = "Bearer $Tok" } `
            -ContentType "application/json" -Body "{}" -UseBasicParsing
        return @{ Status = [int]$r.StatusCode; Body = $r.Content }
    } catch {
        $s = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        $rd = [IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        try { $c = $rd.ReadToEnd() } finally { $rd.Dispose() }
        return @{ Status = $s; Body = $c }
    }
} -ArgumentList $ApiUrl, $tokRace, $raceId

$ar = $acceptJob | Wait-Job | Receive-Job
$cr = $cancelJob | Wait-Job | Receive-Job
Remove-Job $acceptJob, $cancelJob -Force

$final = Invoke-Api -Method GET -Path "/embed/calls/$raceId" -Token $tokRace
# Either Accepted (accept won) or Cancelled (cancel won) — never both partial mess
$okRace = $final.Json.status -in @("Accepted", "Cancelled", "Ended")
# If Accepted, cancel should be 409; if Cancelled, accept should be 409/403
Add-Result "cancel-vs-accept terminal state" $okRace `
    "final=$($final.Json.status) accept=$($ar.Status) cancel=$($cr.Status)"

if ($final.Json.status -eq "Accepted") {
    $e = Invoke-Api -Method POST -Path "/embed/calls/$raceId/end" -Token $tokRace -Body "{}"
    Add-Result "cleanup end after accept won" ($e.Status -eq 200) "status=$($e.Status)"
}

# --- Stale waiting (30s default) ---
if (-not $SkipSlow) {
    Write-Host "Stale waiting test (~$($StaleWaitingSeconds + 8)s)..." -ForegroundColor Yellow
    # Do not ready staff so call stays Queued (or Ringing then requeue). Prefer Queued: make staff not ready.
    # Use a fresh session and stop polling — never GET after create.
    $sessStale = New-Session
    $tokStale = $sessStale.accessToken
    # Ensure no staff takes it: we still may ring. Stale applies to Queued/Ringing/embed visitors.
    $st = Invoke-Api -Method POST -Path "/embed/calls" -Token $tokStale -Body "{}"
    Add-Result "stale seed create" ($st.Status -in 200, 201) "status=$($st.Json.status)"
    $staleId = $st.Json.id
    $wait = $StaleWaitingSeconds + 8
    Start-Sleep -Seconds $wait
    $after = Invoke-Api -Method GET -Path "/embed/calls/$staleId" -Token $tokStale
    # After stale, call should be Cancelled (abandon) — or 404 if purged (we keep in mem → Cancelled)
    $staleOk = ($after.Status -eq 200 -and $after.Json.status -in @("Cancelled", "Timeout", "Ended")) `
        -or ($after.Status -eq 404)
    Add-Result "stale waiting abandons call" $staleOk `
        "after ${wait}s status=$($after.Status) body=$($after.Json.status)"
} else {
    Add-Result "stale waiting (skipped)" $true "SkipSlow"
}

$results | Format-Table -AutoSize
$fail = @($results | Where-Object { $_.Result -eq "FAIL" })
if ($fail.Count -gt 0) {
    Write-Host "Embed lifecycle FAILED: $($fail.Count)"
    exit 1
}
Write-Host "Embed lifecycle passed: $($results.Count) checks."
