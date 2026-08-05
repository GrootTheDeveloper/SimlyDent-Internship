# One-time: register GitHub Actions secrets for VPS deploy.
# Prefers VPS_SSH_KEY_B64 (single-line base64) — avoids "ssh: no key found" from broken newlines.
#
# Prerequisites:
#   gh auth login
#   Deploy key: %USERPROFILE%\.ssh\simlydent_vps_deploy (+ .pub already on VPS)
#
# Usage:
#   .\scripts\setup-github-deploy-secrets.ps1
#   .\scripts\setup-github-deploy-secrets.ps1 -HostName 103.28.32.118 -User root

param(
    [string]$HostName = "103.28.32.118",
    [string]$User = "root",
    [string]$KeyPath = "$env:USERPROFILE\.ssh\simlydent_vps_deploy",
    [string]$Repo = "GrootTheDeveloper/SimlyDent-Internship"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $KeyPath)) {
    Write-Host "Missing private key: $KeyPath" -ForegroundColor Red
    Write-Host "Generate: ssh-keygen -t ed25519 -f `"$KeyPath`" -C github-actions-livekit-vps -N '""""'"
    exit 1
}

gh auth status 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Run: gh auth login" -ForegroundColor Yellow
    exit 1
}

$bytes = [IO.File]::ReadAllBytes((Resolve-Path $KeyPath))
$b64 = [Convert]::ToBase64String($bytes)

Write-Host "Setting secrets on $Repo ..." -ForegroundColor Cyan
$env:GH_REPO = $Repo
gh secret set VPS_HOST --body $HostName
gh secret set VPS_USER --body $User
$b64 | gh secret set VPS_SSH_KEY_B64

Write-Host ""
Write-Host "Done." -ForegroundColor Green
Write-Host "  VPS_HOST        = $HostName"
Write-Host "  VPS_USER        = $User"
Write-Host "  VPS_SSH_KEY_B64 = (base64, $($b64.Length) chars)"
Write-Host ""
Write-Host "If you previously set VPS_SSH_KEY (raw), you can leave it; B64 is preferred."
Write-Host "Test: Actions → Deploy LiveKit VPS → Run workflow"
Write-Host ""
Write-Host "Manual (no gh): create secret VPS_SSH_KEY_B64 and paste this ONE line:"
Write-Host $b64
