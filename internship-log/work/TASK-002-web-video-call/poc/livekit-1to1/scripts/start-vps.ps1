# Deploy the VPS stack from Windows (run ON the VPS if it is Windows Server,
# or use start-vps.sh on a typical Ubuntu/Debian VPS).
param(
    [switch]$WithRecording
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$envPath = Join-Path $root ".env"
$example = Join-Path $root ".env.vps.example"
if (-not (Test-Path -LiteralPath $envPath)) {
    if (Test-Path -LiteralPath $example) {
        Copy-Item $example $envPath
        Write-Host "Created .env from .env.vps.example. Edit DOMAIN, PUBLIC_IP, LIVEKIT_API_SECRET then re-run."
        exit 1
    }
    throw "Missing .env"
}

Get-Content $envPath | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $pair = $_.Split('=', 2)
    if ($pair.Count -eq 2) {
        [Environment]::SetEnvironmentVariable($pair[0].Trim(), $pair[1].Trim(), "Process")
    }
}

foreach ($required in @("DOMAIN", "PUBLIC_IP", "LIVEKIT_API_SECRET")) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($required))) {
        throw "$required is required in .env"
    }
}

if ([string]::IsNullOrWhiteSpace($env:TURN_DOMAIN)) {
    $env:TURN_DOMAIN = $env:DOMAIN
}
if ([string]::IsNullOrWhiteSpace($env:ACME_EMAIL)) {
    $env:ACME_EMAIL = "admin@$($env:DOMAIN)"
}

$compose = Get-Command docker-compose -ErrorAction SilentlyContinue
if ($null -ne $compose) {
    $composeExe = $compose.Source
    $useSubcommand = $false
}
elseif (Test-Path -LiteralPath "C:\Program Files\Docker\Docker\resources\bin\docker-compose.exe") {
    $composeExe = "C:\Program Files\Docker\Docker\resources\bin\docker-compose.exe"
    $useSubcommand = $false
}
else {
    $null = docker compose version 2>$null
    if ($LASTEXITCODE -ne 0) { throw "Docker Compose was not found." }
    $useSubcommand = $true
}

$composeFile = Join-Path $root "docker-compose.vps.yml"
$args = @("-f", $composeFile, "up", "-d", "--build")
if ($WithRecording) { $args = @("-f", $composeFile, "--profile", "recording", "up", "-d", "--build") }

$template = Join-Path $root "infra\livekit.vps.yaml"
$runtime = Join-Path $root "infra\livekit.vps.runtime.yaml"
if (-not (Test-Path -LiteralPath $template)) { throw "Missing $template" }
$text = (Get-Content -LiteralPath $template -Raw) -replace "TURN_DOMAIN_PLACEHOLDER", $env:TURN_DOMAIN
[System.IO.File]::WriteAllText($runtime, $text)
Write-Host "Wrote livekit.vps.runtime.yaml (TURN domain: $($env:TURN_DOMAIN))"

Write-Host "Deploying DOMAIN=$($env:DOMAIN) PUBLIC_IP=$($env:PUBLIC_IP)"
if ($useSubcommand) {
    & docker compose @args
} else {
    & $composeExe @args
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Public URL:  https://$($env:DOMAIN)/?user=A1"
Write-Host "Second user: https://$($env:DOMAIN)/?user=A2"
Write-Host "Open ports: 80,443,7881,3478,50000-50050/udp"
