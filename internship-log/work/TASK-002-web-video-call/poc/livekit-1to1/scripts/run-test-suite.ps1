<#
.SYNOPSIS
  Run PoC automated suites: smoke → clinic isolation → routing → embed session → embed isolation → embed lifecycle.

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

function Invoke-SuiteStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [hashtable]$Params = @{}
    )
    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    # Child scripts often omit `exit 0` on success; leftover $LASTEXITCODE must not abort the suite.
    $global:LASTEXITCODE = 0
    & $ScriptPath @Params
    $code = $global:LASTEXITCODE
    if ($null -ne $code -and $code -ne 0) {
        Write-Host "Suite step failed: $Name (exit $code)" -ForegroundColor Red
        exit $code
    }
}

Invoke-SuiteStep -Name "1/6 smoke-test" -ScriptPath "$PSScriptRoot\smoke-test.ps1" -Params @{ ApiUrl = $ApiUrl }

if (-not $SkipIsolation) {
    $isoParams = @{ ApiUrl = $ApiUrl }
    if ($SkipSignalR) { $isoParams.SkipSignalR = $true }
    Invoke-SuiteStep -Name "2/6 clinic-isolation-test" -ScriptPath "$PSScriptRoot\clinic-isolation-test.ps1" -Params $isoParams
}

$routingParams = @{ ApiUrl = $ApiUrl }
if ($SkipSlow) { $routingParams.SkipSlow = $true }
Invoke-SuiteStep -Name "3/6 routing-test" -ScriptPath "$PSScriptRoot\routing-test.ps1" -Params $routingParams

if (-not $SkipEmbed) {
    Invoke-SuiteStep -Name "4/6 embed-session-test" -ScriptPath "$PSScriptRoot\embed-session-test.ps1" -Params @{ ApiUrl = $ApiUrl }
    Invoke-SuiteStep -Name "5/6 embed-isolation-test" -ScriptPath "$PSScriptRoot\embed-isolation-test.ps1" -Params @{ ApiUrl = $ApiUrl }

    $lifeParams = @{ ApiUrl = $ApiUrl }
    if ($SkipSlow) { $lifeParams.SkipSlow = $true }
    Invoke-SuiteStep -Name "6/6 embed-lifecycle-test" -ScriptPath "$PSScriptRoot\embed-lifecycle-test.ps1" -Params $lifeParams
}

Write-Host ""
Write-Host "All suites passed against $ApiUrl" -ForegroundColor Green
exit 0
