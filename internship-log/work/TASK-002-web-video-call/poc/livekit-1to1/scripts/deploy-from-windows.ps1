# One-shot deploy to UMT VPS from Windows (VPN required).
# Usage:
#   cd ...\poc\livekit-1to1\scripts
#   .\deploy-from-windows.ps1
# You will be prompted for the VPS password once (to install SSH key if needed).

param(
    [string]$VpsHost = "10.11.10.23",
    [string]$User = "sotubuadm",
    [string]$KeyPath = "$env:USERPROFILE\.ssh\id_ed25519_umt"
)

$ErrorActionPreference = "Stop"

Write-Host "=== UMT VPS deploy helper ===" -ForegroundColor Cyan
Write-Host "Host: $User@$VpsHost"
Write-Host "VPN must be connected (ping $VpsHost)."

$ping = Test-Connection -ComputerName $VpsHost -Count 1 -Quiet -ErrorAction SilentlyContinue
if (-not $ping) {
    throw "Cannot ping $VpsHost. Connect VPN (vpn.umt.edu.vn) first."
}

if (-not (Test-Path $KeyPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $KeyPath) | Out-Null
    & ssh-keygen -t ed25519 -f $KeyPath -N '""' -C "grok-umt-deploy"
}

$pub = Get-Content "$KeyPath.pub" -Raw
$sshBase = @(
    "-i", $KeyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "${User}@${VpsHost}"
)

Write-Host "Testing key-based SSH..."
& ssh @sshBase -o BatchMode=yes "echo KEY_OK" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "SSH key not authorized yet. Install public key (enter VPS password once):" -ForegroundColor Yellow
    Write-Host ""
    $remote = "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qxF '$($pub.Trim())' ~/.ssh/authorized_keys || echo '$($pub.Trim())' >> ~/.ssh/authorized_keys && echo KEY_INSTALLED"
    & ssh -o StrictHostKeyChecking=accept-new "${User}@${VpsHost}" $remote
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to install SSH key. Check username/password."
    }
    & ssh @sshBase -o BatchMode=yes "echo KEY_OK"
    if ($LASTEXITCODE -ne 0) {
        throw "Key installed but login still failed."
    }
}

Write-Host "Running remote bootstrap (Docker + clone + compose). This may take 5-15 minutes..." -ForegroundColor Cyan
$bootstrap = @'
set -e
export VPN_IP=10.11.10.23
if [[ -f "$HOME/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/scripts/bootstrap-umt-vpn.sh" ]]; then
  bash "$HOME/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/scripts/bootstrap-umt-vpn.sh"
else
  # First run: fetch bootstrap from GitHub raw or clone then run
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl
  if [[ ! -d "$HOME/SimlyDent-Internship/.git" ]]; then
    git clone https://github.com/GrootTheDeveloper/SimlyDent-Internship.git "$HOME/SimlyDent-Internship"
  else
    git -C "$HOME/SimlyDent-Internship" pull --ff-only || true
  fi
  bash "$HOME/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/scripts/bootstrap-umt-vpn.sh"
fi
'@

# Push bootstrap content for offline-first path: also pipe local script if present
$localBootstrap = Join-Path $PSScriptRoot "bootstrap-umt-vpn.sh"
if (Test-Path $localBootstrap) {
    Write-Host "Uploading local bootstrap script..."
    Get-Content -Raw $localBootstrap | & ssh @sshBase "cat > /tmp/bootstrap-umt-vpn.sh && chmod +x /tmp/bootstrap-umt-vpn.sh"
    & ssh @sshBase "export VPN_IP=10.11.10.23; bash /tmp/bootstrap-umt-vpn.sh"
} else {
    & ssh @sshBase $bootstrap
}

if ($LASTEXITCODE -ne 0) {
    throw "Remote bootstrap failed with exit $LASTEXITCODE"
}

Write-Host ""
Write-Host "=== Deploy finished ===" -ForegroundColor Green
Write-Host "1) Install CA:  http://${VpsHost}:8088/root.crt  -> Trusted Root"
Write-Host "2) Open:       https://${VpsHost}:8443/?user=A1"
Write-Host "3) Other tab:  https://${VpsHost}:8443/?user=A2"
