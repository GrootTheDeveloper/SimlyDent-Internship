param(
    [string]$ApiUrl = "http://localhost:5080",
    [string]$LiveKitUrl = "ws://localhost:7880",
    [string]$LiveKitCli
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envValues = @{}
Get-Content -LiteralPath (Join-Path $root ".env") | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { $envValues[$matches[1]] = $matches[2] }
}

if ([string]::IsNullOrWhiteSpace($LiveKitCli)) {
    $command = Get-Command lk -ErrorAction SilentlyContinue
    if ($command) {
        $LiveKitCli = $command.Source
    }
    else {
        $LiveKitCli = Join-Path $env:TEMP "simlydent-livekit-cli-2.18.2\lk.exe"
    }
}
if (-not (Test-Path -LiteralPath $LiveKitCli)) {
    throw "LiveKit CLI was not found. Install lk or pass -LiveKitCli."
}

$headersA1 = @{ "X-User-Id" = "A1" }
$headersA2 = @{ "X-User-Id" = "A2" }
$call = Invoke-RestMethod `
    -Method Post `
    -Uri "$ApiUrl/api/calls" `
    -Headers $headersA1 `
    -ContentType "application/json" `
    -Body '{"calleeId":"A2"}'
Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/calls/$($call.id)/accept" -Headers $headersA2 | Out-Null

$publisher = $null
try {
    $publisher = Start-Process `
        -FilePath $LiveKitCli `
        -ArgumentList @(
            "room", "join",
            "--url", $LiveKitUrl,
            "--api-key", $envValues["LIVEKIT_API_KEY"],
            "--api-secret", $envValues["LIVEKIT_API_SECRET"],
            "--identity", "recording-test-publisher",
            "--publish-demo",
            $call.roomName
        ) `
        -RedirectStandardOutput (Join-Path $root "evidence\recording-publisher.stdout.log") `
        -RedirectStandardError (Join-Path $root "evidence\recording-publisher.stderr.log") `
        -PassThru `
        -WindowStyle Hidden

    Start-Sleep -Seconds 6
    if ($publisher.HasExited) {
        throw "Demo publisher exited early with code $($publisher.ExitCode)."
    }

    $started = Invoke-RestMethod `
        -Method Post `
        -Uri "$ApiUrl/api/calls/$($call.id)/recording/start" `
        -Headers $headersA1
    Write-Host "Recording started: $($started.recordingEgressId)"

    Start-Sleep -Seconds 12
    $stopped = Invoke-RestMethod `
        -Method Post `
        -Uri "$ApiUrl/api/calls/$($call.id)/recording/stop" `
        -Headers $headersA1

    $file = Get-Item -LiteralPath (Join-Path $root "recordings\$($stopped.recordingFileName)")
    $download = Invoke-WebRequest `
        -Uri "$ApiUrl/api/calls/$($call.id)/recording/file" `
        -Headers $headersA1 `
        -UseBasicParsing
    if ($stopped.recordingStatus -ne "Complete" -or
        -not $stopped.recordingAvailable -or
        $file.Length -le 0 -or
        $download.StatusCode -ne 200) {
        throw "Recording did not complete correctly."
    }

    try {
        Invoke-WebRequest `
            -Uri "$ApiUrl/api/calls/$($call.id)/recording/file" `
            -Headers @{ "X-User-Id" = "B1" } `
            -UseBasicParsing | Out-Null
        throw "A cross-tenant user downloaded the recording."
    }
    catch {
        if ($null -eq $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404) {
            throw
        }
    }

    Write-Host "Recording E2E passed: $($file.Name), $($file.Length) bytes; cross-tenant download blocked."
}
finally {
    if ($publisher -and -not $publisher.HasExited) {
        Stop-Process -Id $publisher.Id
    }
    try {
        Invoke-RestMethod -Method Post -Uri "$ApiUrl/api/calls/$($call.id)/end" -Headers $headersA1 | Out-Null
    }
    catch {
        # The test result above is authoritative; cleanup is best effort.
    }
}
