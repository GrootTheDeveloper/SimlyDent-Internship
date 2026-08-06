# SSH tunnel so Windows can use the UMT VPS app when the campus network
# only allows SSH (port 22) from the VPN client to the server.
#
# Usage (VPN ON):
#   .\start-umt-tunnel.ps1
# Then open: https://127.0.0.1:18443/?user=A1
#
# Note: WebRTC media (UDP) still needs network path to 10.11.10.23.
# If video fails after UI works, ask IT to open UDP 50000-50020 and TCP 7881.

param(
    [string]$VpsHost = "10.11.10.23",
    [string]$User = "sotubuadm",
    [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519_umt"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $KeyPath)) {
    throw "Missing SSH key: $KeyPath"
}

Write-Host "Starting SSH tunnels to ${User}@${VpsHost} ..." -ForegroundColor Cyan
Write-Host "  local 15080 -> VPS 5080  (API)"
Write-Host "  local 15173 -> VPS 5173  (UI plain)"
Write-Host "  local 18088 -> VPS 8088  (CA)"
Write-Host "  local 18443 -> VPS 8443  (HTTPS UI)"
Write-Host "  local 17880 -> VPS 7880  (LiveKit signaling)"
Write-Host "  local 17881 -> VPS 7881  (LiveKit RTC TCP)"
Write-Host ""
Write-Host "Keep this window open. Ctrl+C to stop." -ForegroundColor Yellow
Write-Host "Browser: https://127.0.0.1:18443/?user=A1" -ForegroundColor Green

& ssh `
  -i $KeyPath `
  -o IdentitiesOnly=yes `
  -o ServerAliveInterval=30 `
  -o ExitOnForwardFailure=yes `
  -N `
  -L "15080:127.0.0.1:5080" `
  -L "15173:127.0.0.1:5173" `
  -L "18088:127.0.0.1:8088" `
  -L "18443:127.0.0.1:8443" `
  -L "17880:127.0.0.1:7880" `
  -L "17881:127.0.0.1:7881" `
  "${User}@${VpsHost}"
