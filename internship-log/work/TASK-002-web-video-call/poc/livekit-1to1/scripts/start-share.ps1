param(
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

& (Join-Path $PSScriptRoot "start.ps1") -NoBuild:$NoBuild
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$compose = Get-Command docker-compose -ErrorAction SilentlyContinue
if ($null -ne $compose) {
    $composeExe = $compose.Source
}
elseif (Test-Path -LiteralPath "C:\Program Files\Docker\Docker\resources\bin\docker-compose.exe") {
    $composeExe = "C:\Program Files\Docker\Docker\resources\bin\docker-compose.exe"
}
else {
    throw "Docker Compose was not found."
}

$composeFile = Join-Path $root "docker-compose.yml"
& $composeExe -f $composeFile --profile share up -d --force-recreate cloudflared
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$publicUrl = $null
for ($attempt = 0; $attempt -lt 30 -and -not $publicUrl; $attempt++) {
    Start-Sleep -Seconds 1
    $logs = & $composeExe -f $composeFile logs --no-color cloudflared 2>&1 | Out-String
    $match = [regex]::Match($logs, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($match.Success) { $publicUrl = $match.Value }
}

if (-not $publicUrl) {
    throw "Cloudflare Quick Tunnel did not publish a URL within 30 seconds. Check the cloudflared container logs."
}

Write-Host ""
Write-Host "PUBLIC TEST URL: $publicUrl" -ForegroundColor Green
Write-Host "Send this link directly to testers. No certificate installation is required."
Write-Host "The URL changes whenever the cloudflared container is recreated."
