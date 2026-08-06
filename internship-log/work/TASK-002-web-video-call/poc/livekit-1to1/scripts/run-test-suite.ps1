<#
.SYNOPSIS
  Run PoC automated suites in order: smoke → clinic isolation → routing.

.EXAMPLE
  .\scripts\run-test-suite.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
  .\scripts\run-test-suite.ps1 -ApiUrl "http://localhost:5080" -SkipSlow
#>
param(
    [string]$ApiUrl = "http://localhost:5080",
    [switch]$SkipSlow,
    [switch]$SkipSignalR,
    [switch]$SkipIsolation
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "=== 1/3 smoke-test ===" -ForegroundColor Cyan
& "$PSScriptRoot\smoke-test.ps1" -ApiUrl $ApiUrl
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipIsolation) {
    Write-Host ""
    Write-Host "=== 2/3 clinic-isolation-test ===" -ForegroundColor Cyan
    & "$PSScriptRoot\clinic-isolation-test.ps1" -ApiUrl $ApiUrl -SkipSignalR:$SkipSignalR
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

Write-Host ""
Write-Host "=== 3/3 routing-test ===" -ForegroundColor Cyan
if ($SkipSlow) {
    & "$PSScriptRoot\routing-test.ps1" -ApiUrl $ApiUrl -SkipSlow
} else {
    & "$PSScriptRoot\routing-test.ps1" -ApiUrl $ApiUrl
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "All suites passed against $ApiUrl" -ForegroundColor Green
