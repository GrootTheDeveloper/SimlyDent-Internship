<#
.SYNOPSIS
  Run PoC automated suites: smoke → clinic isolation → routing → embed session → embed isolation.

.EXAMPLE
  .\scripts\run-test-suite.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
  .\scripts\run-test-suite.ps1 -ApiUrl "http://localhost:5080" -SkipSlow
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [switch]$SkipSlow,
    [switch]$SkipSignalR,
    [switch]$SkipIsolation,
    [switch]$SkipEmbed
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== 1/6 smoke-test ===" -ForegroundColor Cyan
& "$PSScriptRoot\smoke-test.ps1" -ApiUrl $ApiUrl
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipIsolation) {
    Write-Host ""
    Write-Host "=== 2/6 clinic-isolation-test ===" -ForegroundColor Cyan
    & "$PSScriptRoot\clinic-isolation-test.ps1" -ApiUrl $ApiUrl -SkipSignalR:$SkipSignalR
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "=== 3/6 routing-test ===" -ForegroundColor Cyan
if ($SkipSlow) {
    & "$PSScriptRoot\routing-test.ps1" -ApiUrl $ApiUrl -SkipSlow
} else {
    & "$PSScriptRoot\routing-test.ps1" -ApiUrl $ApiUrl
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipEmbed) {
    Write-Host ""
    Write-Host "=== 4/6 embed-session-test ===" -ForegroundColor Cyan
    & "$PSScriptRoot\embed-session-test.ps1" -ApiUrl $ApiUrl
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host ""
    Write-Host "=== 5/6 embed-isolation-test ===" -ForegroundColor Cyan
    & "$PSScriptRoot\embed-isolation-test.ps1" -ApiUrl $ApiUrl
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    Write-Host ""
    Write-Host "=== 6/6 embed-lifecycle-test ===" -ForegroundColor Cyan
    if ($SkipSlow) {
        & "$PSScriptRoot\embed-lifecycle-test.ps1" -ApiUrl $ApiUrl -SkipSlow
    } else {
        & "$PSScriptRoot\embed-lifecycle-test.ps1" -ApiUrl $ApiUrl
    }
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "All suites passed against $ApiUrl" -ForegroundColor Green
