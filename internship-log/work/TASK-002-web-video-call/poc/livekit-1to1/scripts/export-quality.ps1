<#
.SYNOPSIS
  Export quality telemetry for a real 1:1 call (JWT) to CSV/JSON under evidence/.

.DESCRIPTION
  After (or during) a two-device call, samples are already posted by the browser.
  This script logs in, pulls export from the API, and saves files for PERF runs.

.EXAMPLE
  .\scripts\export-quality.ps1 -CallId "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" -UserId A1

  .\scripts\export-quality.ps1 -CallId $id -ApiUrl "https://103.28.32.118.sslip.io" -UserId A1
#>
param(
    [Parameter(Mandatory = $true)][string]$CallId,
    [string]$ApiUrl = "http://localhost:5080",
    [string]$UserId = "A1",
    [string]$DemoPassword = "Demo@123",
    [ValidateSet("csv", "json", "both")][string]$Format = "both",
    [string]$OutDir,
    [string]$RunLabel = ""
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "lib\poc-load-common.ps1")

$root = Get-PocRoot
if (-not $OutDir) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $label = if ($RunLabel) { $RunLabel } else { "run" }
    $OutDir = Join-Path $root "evidence\perf-real\exports\$label-$stamp"
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# Normalize API base (strip trailing slash; VPS may be same-origin via gateway)
$ApiUrl = $ApiUrl.TrimEnd('/')

Write-Host "Export quality: call=$CallId user=$UserId api=$ApiUrl"
Write-Host "OutDir: $OutDir"

$cache = @{}
$token = Get-PocAccessToken -ApiUrl $ApiUrl -UserId $UserId -Password $DemoPassword -Cache $cache
$headers = @{ Authorization = "Bearer $token" }

# Optional summary probe
try {
    $summary = Invoke-RestMethod -Method Get -Uri "$ApiUrl/api/calls/$CallId/quality/summary" -Headers $headers
    $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $OutDir "summary.json") -Encoding UTF8
    Write-Host "Samples on server: $($summary.sampleCount)"
}
catch {
    Write-Host "WARN: quality summary failed (call may be missing samples): $($_.Exception.Message)"
}

function Save-Export([string]$Fmt) {
    $uri = "$ApiUrl/api/calls/$CallId/quality/export?format=$Fmt"
    $outFile = Join-Path $OutDir "call-$CallId-quality.$Fmt"
    $resp = Invoke-WebRequest -Uri $uri -Headers $headers -UseBasicParsing
    if ($resp.StatusCode -ne 200) {
        throw "Export $Fmt HTTP $($resp.StatusCode)"
    }
    if ($Fmt -eq "csv") {
        # Content may be string
        [System.IO.File]::WriteAllText($outFile, $resp.Content, [System.Text.UTF8Encoding]::new($false))
    }
    else {
        [System.IO.File]::WriteAllBytes($outFile, $resp.RawContentStream.ToArray())
        # Fallback if stream empty
        if (-not (Test-Path $outFile) -or (Get-Item $outFile).Length -eq 0) {
            [System.IO.File]::WriteAllText($outFile, $resp.Content, [System.Text.UTF8Encoding]::new($false))
        }
    }
    Write-Host "Wrote $outFile ($((Get-Item $outFile).Length) bytes)"
    return $outFile
}

$files = @()
if ($Format -eq "both" -or $Format -eq "csv") { $files += Save-Export "csv" }
if ($Format -eq "both" -or $Format -eq "json") { $files += Save-Export "json" }

$meta = [ordered]@{
    callId     = $CallId
    userId     = $UserId
    apiUrl     = $ApiUrl
    exportedAt = [DateTimeOffset]::UtcNow.ToString("o")
    files      = $files
}
$meta | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutDir "export-meta.json") -Encoding UTF8

Write-Host "Done. Point aggregate script at parent folder of several exports if needed."
Write-Host "  .\scripts\aggregate-quality-exports.ps1 -InputDir `"$OutDir\..`""
exit 0
