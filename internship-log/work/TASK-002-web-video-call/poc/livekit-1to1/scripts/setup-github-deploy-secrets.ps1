# One-time: create/register GitHub Actions secrets for VPS deploy.
# Prerequisites: GitHub CLI logged in (`gh auth login`), deploy key at ~/.ssh/simlydent_vps_deploy
#
# Usage (from repo root or any dir):
#   .\internship-log\work\TASK-002-web-video-call\poc\livekit-1to1\scripts\setup-github-deploy-secrets.ps1
#   .\...\setup-github-deploy-secrets.ps1 -Host 103.28.32.118 -User root

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

$key = Get-Content -Raw $KeyPath
if ($key -notmatch "BEGIN .*PRIVATE KEY") {
    Write-Host "File does not look like a private key: $KeyPath" -ForegroundColor Red
    exit 1
}

Write-Host "Setting secrets on $Repo ..." -ForegroundColor Cyan
$env:GH_REPO = $Repo
gh secret set VPS_HOST --body $HostName
gh secret set VPS_USER --body $User
# Pass key via stdin to preserve newlines
$key | gh secret set VPS_SSH_KEY

Write-Host "Done. Secrets: VPS_HOST, VPS_USER, VPS_SSH_KEY" -ForegroundColor Green
Write-Host "Test: GitHub → Actions → Deploy LiveKit VPS → Run workflow"
