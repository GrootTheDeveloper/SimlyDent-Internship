# Phase C Direct S3 E2E (primary path = real LiveKit recording).
# Plant is NOT valid Direct S3 proof.
#
# Prerequisites:
#   - MINIO_LAB + S3_DOMAIN + RECORDING_STORAGE=s3 + EGRESS_OUTPUT=s3
#   - S3_PUBLIC_ENDPOINT=https://s3.DOMAIN (HTTPS, no path)
#   - Non-root S3_ACCESS_KEY from minio-lab-bootstrap.sh
#   - Staff A1/A2 + Manager A-MGR Demo@123
#
# Usage:
#   .\scripts\recording-s3-e2e.ps1 -BaseUrl https://103.28.32.118.sslip.io
# Then complete a real call with recording start/stop in the browser (or automate if tokens allow).
# This script validates config/health, issues Manager download-url checks, and writes evidence skeleton.

param(
    [string]$BaseUrl = "https://103.28.32.118.sslip.io",
    [string]$ManagerId = "A-MGR",
    [string]$Password = "Demo@123",
    [string]$EvidenceDir = ""
)

$ErrorActionPreference = "Stop"
if (-not $EvidenceDir) {
    $EvidenceDir = Join-Path (Split-Path $PSScriptRoot -Parent) "evidence\phase-c-s3-lab"
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null

function Invoke-Json {
    param($Method, $Path, $Token, $Body)
    $headers = @{ "Content-Type" = "application/json" }
    if ($Token) { $headers["Authorization"] = "Bearer $Token" }
    $params = @{
        Method = $Method
        Uri = "$BaseUrl$Path"
        Headers = $headers
    }
    if ($Body) { $params.Body = ($Body | ConvertTo-Json -Compress) }
    return Invoke-RestMethod @params
}

Write-Host "=== Health ==="
$health = Invoke-RestMethod -Uri "$BaseUrl/health"
$health | ConvertTo-Json | Tee-Object (Join-Path $EvidenceDir "health.json")
if ($health.status -ne "ok") { throw "health not ok" }

Write-Host "=== Manager login ==="
$login = Invoke-Json -Method POST -Path "/api/auth/login" -Body @{ userId = $ManagerId; password = $Password }
$token = $login.accessToken
if (-not $token) { throw "no accessToken" }

Write-Host "=== Config checklist (manual + automated) ==="
$checks = [ordered]@{
    health_ok = ($health.status -eq "ok")
    recordingStorage = $health.recordingStorage
    egressOutput = $health.egressOutput
    s3PublicConfigured = $health.s3PublicConfigured
    supportsPresignedGet = $health.supportsPresignedGet
    note = "PRIMARY EVIDENCE requires real Staff start/stop recording, not plant."
}
$checks | ConvertTo-Json | Tee-Object (Join-Path $EvidenceDir "config-checklist.json")

Write-Host @"

=== NEXT: Real recording (mandatory for Phase C) ===
1. Open $BaseUrl as A1 and A2 (or embed visitor + staff).
2. Accept call, grant consent if needed, set mode Video, Start recording.
3. Stop recording (or end call). Expect Finalizing then Ready (webhook/reconcile).
4. As A-MGR, open library, download.
5. Confirm Network tab:
   - GET /api/calls/{id}/recording/download-url  (small JSON)
   - GET https://s3.DOMAIN/bucket/key?...        (video bytes)
   - API did NOT stream Results.File for happy path

Then fill evidence template:
"@

$template = @"
# Phase C Direct S3 lab evidence

Date (UTC): $(Get-Date -Format o)
BaseUrl: $BaseUrl
Git SHA: (fill from VPS git log -1)

## Config
- EGRESS_OUTPUT=s3
- RECORDING_STORAGE=s3
- S3_PUBLIC_ENDPOINT=https://s3....
- S3_INTERNAL_ENDPOINT=http://minio:9000
- Non-root S3_ACCESS_KEY: yes/no

## Real recording (required)
- Call ID:
- Recording ID:
- Egress ID:
- Storage key:
- StartedAt / FinalizingAt / ReadyAt:
- Object bytes / duration:
- Presigned host (must be s3.DOMAIN):
- Browser GET status:

## Byte-path proof
- [ ] WRITE: Egress → HTTPS → MinIO (no API PutObject/SaveFromLocalFileAsync)
- [ ] READ: Browser → presigned GET → MinIO (no API Results.File happy path)
- [ ] download-url returned mode=presign
- [ ] Cross-clinic denied

## Health snapshot
``````
$($health | ConvertTo-Json)
``````
"@
$template | Set-Content (Join-Path $EvidenceDir "EVIDENCE.template.md") -Encoding utf8
Write-Host "Wrote $EvidenceDir"
Write-Host "DONE skeleton"
