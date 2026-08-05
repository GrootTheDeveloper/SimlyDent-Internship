param(
    [switch]$NoBuild,
    [string]$LanAddress
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"
if ([string]::IsNullOrWhiteSpace($LanAddress)) {
    $hotspotAddress = Get-NetIPConfiguration | Where-Object {
        $_.NetAdapter.Status -eq "Up" -and
        $_.InterfaceDescription -match "Wi-Fi Direct" -and
        $_.IPv4Address.IPAddress -notlike "169.254.*"
    } | Select-Object -First 1 -ExpandProperty IPv4Address | Select-Object -ExpandProperty IPAddress

    if (-not [string]::IsNullOrWhiteSpace($hotspotAddress)) {
        $lanAddress = $hotspotAddress
    }
    else {
        $lanAddress = Get-NetIPConfiguration | Where-Object {
            $_.NetAdapter.Status -eq "Up" -and $_.IPv4DefaultGateway -and $_.IPv4Address
        } | Select-Object -First 1 -ExpandProperty IPv4Address | Select-Object -ExpandProperty IPAddress
    }
}
else {
    $lanAddress = $LanAddress
}

if ([string]::IsNullOrWhiteSpace($lanAddress)) {
    throw "No active LAN/Wi-Fi IPv4 address with a default gateway was found."
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdministrator) {
    $firewallRules = @(
        @{ Name = "SimlyDent LiveKit RTC UDP"; Protocol = "UDP"; LocalPort = "50000-50020" },
        @{ Name = "SimlyDent LiveKit RTC TCP"; Protocol = "TCP"; LocalPort = "7881" }
    )
    foreach ($rule in $firewallRules) {
        if (-not (Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue)) {
            New-NetFirewallRule `
                -DisplayName $rule.Name `
                -Direction Inbound `
                -Action Allow `
                -Profile Private,Public `
                -Protocol $rule.Protocol `
                -LocalPort $rule.LocalPort | Out-Null
        }
    }
}
else {
    Write-Warning "Run this script once as Administrator to open LiveKit UDP 50000-50020 and TCP 7881."
}

if (-not (Test-Path -LiteralPath $envPath)) {
    $bytes = New-Object byte[] 36
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    $secret = [Convert]::ToBase64String($bytes)
    @(
        "LIVEKIT_API_KEY=devkey"
        "LIVEKIT_API_SECRET=$secret"
        "LAN_IP=$lanAddress"
    ) | Set-Content -LiteralPath $envPath -Encoding Ascii
    Write-Host "Generated local LiveKit credentials in .env."
}
else {
    $envLines = Get-Content -LiteralPath $envPath
    $hasLanIp = $false
    $updatedLines = foreach ($line in $envLines) {
        if ($line -match '^LAN_IP=') {
            $hasLanIp = $true
            "LAN_IP=$lanAddress"
        }
        elseif ($line -notmatch '^LIVEKIT_PUBLIC_URL=') {
            $line
        }
    }
    if (-not $hasLanIp) { $updatedLines += "LAN_IP=$lanAddress" }
    $updatedLines | Set-Content -LiteralPath $envPath -Encoding Ascii
}

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

$arguments = @("-f", (Join-Path $root "docker-compose.yml"), "up", "-d")
if (-not $NoBuild) { $arguments += "--build" }
& $composeExe @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Start-Sleep -Seconds 2
$certDirectory = Join-Path $root "certs"
New-Item -ItemType Directory -Force -Path $certDirectory | Out-Null
$gatewayId = (& $composeExe -f (Join-Path $root "docker-compose.yml") ps -q gateway).Trim()
if ($gatewayId) {
    & docker cp "${gatewayId}:/data/caddy/pki/authorities/local/root.crt" (Join-Path $certDirectory "livekit-lan-root-ca.crt") | Out-Null
}

Write-Host "Local URL: http://localhost:5173"
Write-Host "LAN HTTPS URL: https://${lanAddress}:8443"
Write-Host "CA download: http://${lanAddress}:8088/root.crt"
