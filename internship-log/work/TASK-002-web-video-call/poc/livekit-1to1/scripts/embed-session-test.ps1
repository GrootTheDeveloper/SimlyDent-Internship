<#
.SYNOPSIS
  Phase 2 PR-A — embed session bootstrap + origin allowlist + auth boundary.

.EXAMPLE
  .\scripts\embed-session-test.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
  .\scripts\embed-session-test.ps1 -ApiUrl "http://localhost:5080"
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

function Invoke-EmbedSession {
    param(
        [string]$SiteKey,
        [string]$Origin,
        [switch]$NoOrigin
    )
    $headers = @{ }
    if (-not $NoOrigin) {
        if ($null -eq $Origin) {
            $headers["Origin"] = "null"
        } else {
            $headers["Origin"] = $Origin
        }
    }
    $body = @{ siteKey = $SiteKey } | ConvertTo-Json -Compress
    try {
        $r = Invoke-WebRequest -Method Post -Uri "$ApiUrl/embed/session" `
            -Headers $headers -ContentType "application/json" -Body $body -UseBasicParsing
        return @{
            Status = [int]$r.StatusCode
            Json = $(if ($r.Content) { $r.Content | ConvertFrom-Json } else { $null })
            Body = $r.Content
        }
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

function Get-JwtPayload([string]$jwt) {
    $part = $jwt.Split('.')[1].Replace('-', '+').Replace('_', '/')
    while ($part.Length % 4) { $part += '=' }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($part)) | ConvertFrom-Json
}

Write-Host "Embed session tests against $ApiUrl"
Write-Host "OriginA=$OriginA OriginB=$OriginB"

$health = Invoke-WebRequest -Uri "$ApiUrl/health" -UseBasicParsing
Add-Result "Health" ($health.StatusCode -eq 200)

# Happy path clinic A
$ok = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin $OriginA
Add-Result "known site key + correct Origin" ($ok.Status -eq 200) "status=$($ok.Status)"
Add-Result "session clinic-a" ($ok.Json.clinicId -eq "clinic-a") "clinic=$($ok.Json.clinicId)"
Add-Result "session has token" (-not [string]::IsNullOrWhiteSpace($ok.Json.accessToken)) "len=$($ok.Json.accessToken.Length)"
Add-Result "session has sessionId" (-not [string]::IsNullOrWhiteSpace($ok.Json.sessionId)) "id=$($ok.Json.sessionId)"

$claims = Get-JwtPayload $ok.Json.accessToken
$tokenUse = $claims.token_use
if (-not $tokenUse) { $tokenUse = $claims.tokenUse }
$clinicClaim = $claims.clinic_id
if (-not $clinicClaim) { $clinicClaim = $claims.clinicId }
$sessionClaim = $claims.session_id
if (-not $sessionClaim) { $sessionClaim = $claims.sessionId }
Add-Result "JWT token_use embed" ($tokenUse -eq "embed") "token_use=$tokenUse"
Add-Result "JWT clinic_id" ($clinicClaim -eq "clinic-a") "clinic_id=$clinicClaim"
Add-Result "JWT session_id present" (-not [string]::IsNullOrWhiteSpace($sessionClaim)) "session_id=$sessionClaim"
Add-Result "JWT aud embed" ($claims.aud -eq "simlydent-embed" -or $claims.aud -contains "simlydent-embed") "aud=$($claims.aud)"

# Unknown key
$unk = Invoke-EmbedSession -SiteKey "pk_unknown" -Origin $OriginA
Add-Result "unknown site key 404" ($unk.Status -eq 404) "status=$($unk.Status)"

# Wrong origin
$badOrigin = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin "https://evil.example"
Add-Result "wrong origin 403" ($badOrigin.Status -eq 403) "status=$($badOrigin.Status)"

# Origin binding 4-way (site_key ↔ allowed origin, symmetric)
# 1) A+A and 2) B+B covered by happy paths above / below
# 3) Origin B + site_key A
$crossBA = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin $OriginB
Add-Result "origin B + site_key A 403" ($crossBA.Status -eq 403) "status=$($crossBA.Status)"
# 4) Origin A + site_key B
$crossAB = Invoke-EmbedSession -SiteKey "pk_clinic_b" -Origin $OriginA
Add-Result "origin A + site_key B 403" ($crossAB.Status -eq 403) "status=$($crossAB.Status)"

# Wrong scheme (if OriginA is http, try https same host/port)
try {
    $uriA = [Uri]$OriginA
    $wrongScheme = if ($uriA.Scheme -eq "http") {
        "https://$($uriA.IdnHost):$($uriA.Port)"
    } else {
        "http://$($uriA.IdnHost):$($uriA.Port)"
    }
    $ws = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin $wrongScheme
    Add-Result "wrong scheme 403" ($ws.Status -eq 403) "origin=$wrongScheme status=$($ws.Status)"
} catch {
    Add-Result "wrong scheme test skipped" $true $_.Exception.Message
}

# Wrong port
try {
    $uriA = [Uri]$OriginA
    $wrongPort = "$($uriA.Scheme)://$($uriA.IdnHost):9"
    $wp = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin $wrongPort
    Add-Result "wrong port 403" ($wp.Status -eq 403) "status=$($wp.Status)"
} catch {
    Add-Result "wrong port test skipped" $true $_.Exception.Message
}

# Malicious suffix host
$suffix = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin "http://evil127.0.0.1.nip.io:5174"
Add-Result "malicious suffix host 403" ($suffix.Status -eq 403) "status=$($suffix.Status)"

# Origin: null string
$nullOrigin = Invoke-EmbedSession -SiteKey "pk_clinic_a" -Origin $null
Add-Result "Origin null string 403" ($nullOrigin.Status -eq 403) "status=$($nullOrigin.Status)"

# Missing Origin header
$missing = Invoke-EmbedSession -SiteKey "pk_clinic_a" -NoOrigin
Add-Result "missing Origin 403" ($missing.Status -eq 403) "status=$($missing.Status)"

# Clinic B happy path
$okB = Invoke-EmbedSession -SiteKey "pk_clinic_b" -Origin $OriginB
Add-Result "clinic B session" ($okB.Status -eq 200 -and $okB.Json.clinicId -eq "clinic-b") "status=$($okB.Status) clinic=$($okB.Json.clinicId)"

# Staff JWT cannot call staff overview as embed — embed token on staff API
$embedTok = $ok.Json.accessToken
try {
    $r = Invoke-WebRequest -Method Get -Uri "$ApiUrl/api/agents" `
        -Headers @{ Authorization = "Bearer $embedTok" } -UseBasicParsing
    $st = [int]$r.StatusCode
} catch {
    $st = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
}
Add-Result "embed token cannot use /api/agents" ($st -in @(401, 403)) "status=$st"

# Staff login still works; full EmbedBearer rejection covered by embed-isolation-test.ps1.
$login = Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/auth/login" `
    -ContentType "application/json" `
    -Body (@{ userId = "A1"; password = $DemoPassword } | ConvertTo-Json -Compress)
Add-Result "staff login still works" (-not [string]::IsNullOrWhiteSpace($login.accessToken)) "ok"

$staffTok = $login.accessToken
$staffClaims = Get-JwtPayload $staffTok
Add-Result "staff aud is not embed" ($staffClaims.aud -ne "simlydent-embed") "aud=$($staffClaims.aud)"

$results | Format-Table -AutoSize
$fail = @($results | Where-Object { $_.Result -eq "FAIL" })
if ($fail.Count -gt 0) {
    Write-Host "Embed session FAILED: $($fail.Count)"
    exit 1
}
Write-Host "Embed session passed: $($results.Count) checks."
