$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from PowerShell as Administrator."
}

$rules = @(
    @{ Name = "SimlyDent LiveKit LAN HTTPS"; Protocol = "TCP"; LocalPort = "8443" },
    @{ Name = "SimlyDent LiveKit CA Download"; Protocol = "TCP"; LocalPort = "8088" },
    @{ Name = "SimlyDent LiveKit RTC TCP"; Protocol = "TCP"; LocalPort = "7881" },
    @{ Name = "SimlyDent LiveKit LAN Media"; Protocol = "UDP"; LocalPort = "50000-50020" }
)

foreach ($rule in $rules) {
    Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Action Allow `
        -Profile Private,Public `
        -Protocol $rule.Protocol `
        -LocalPort $rule.LocalPort | Out-Null
}

Write-Host "LAN firewall rules enabled for HTTPS, CA download, RTC TCP and RTC UDP."
