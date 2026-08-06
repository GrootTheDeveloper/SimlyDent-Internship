<#
.SYNOPSIS
  PR-E multi-origin harness: two fake clinic websites on different ports.
  Widget JS + iframe + Embed API load from remote SimlyDent (-ApiBase), not from these ports.

.DESCRIPTION
  Origin = scheme + host + port only. Path differences are NOT different origins.

  Architecture:
    http://127.0.0.1:5174  = website Clinic A  → remote {ApiBase}/widget/embed.js  site_key=pk_clinic_a
    http://127.0.0.1:5175  = website Clinic B  → remote {ApiBase}/widget/embed.js  site_key=pk_clinic_b

  Does NOT serve frontend/public/widget as the clinic site root.

.EXAMPLE
  .\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io"
  .\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io" -ProbeOnly
  .\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io" -ProbeAndServe
#>
param(
    [Parameter(Mandatory = $true)]
    [string]$ApiBase,

    [int]$PortA = 5174,
    [int]$PortB = 5175,

    [string]$HostName = "127.0.0.1",

    [string]$SiteKeyA = "pk_clinic_a",
    [string]$SiteKeyB = "pk_clinic_b",

    [string]$NameA = "Nha khoa Demo A",
    [string]$NameB = "Nha khoa Demo B",

    [string]$ColorA = "#0d9488",
    [string]$ColorB = "#2563eb",

    # Only run 4-way origin binding against API (no HTTP servers)
    [switch]$ProbeOnly,

    # Probe first, then serve (default when neither switch: serve only)
    [switch]$ProbeAndServe
)

$ErrorActionPreference = "Stop"
$ApiBase = $ApiBase.TrimEnd('/')

$OriginA = "http://${HostName}:${PortA}"
$OriginB = "http://${HostName}:${PortB}"
$EmbedJs = "$ApiBase/widget/embed.js"
$StaffPortal = $ApiBase

function Get-ClinicHtml {
    param(
        [string]$ClinicTitle,
        [string]$ClinicSubtitle,
        [string]$SiteKey,
        [string]$Color,
        [string]$ApiBaseUrl,
        [string]$PeerNote
    )
    $titleEsc = [System.Net.WebUtility]::HtmlEncode($ClinicTitle)
    $subEsc = [System.Net.WebUtility]::HtmlEncode($ClinicSubtitle)
    $peerEsc = [System.Net.WebUtility]::HtmlEncode($PeerNote)
    $skEsc = [System.Net.WebUtility]::HtmlEncode($SiteKey)
    $colorEsc = [System.Net.WebUtility]::HtmlEncode($Color)
    $apiEsc = [System.Net.WebUtility]::HtmlEncode($ApiBaseUrl)
    $embedEsc = [System.Net.WebUtility]::HtmlEncode("$ApiBaseUrl/widget/embed.js")

    @"
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>$titleEsc — fake clinic site</title>
  <style>
    body { margin:0; font-family:"Segoe UI",system-ui,sans-serif; background:#f8fafc; color:#0f172a; }
    header { background:linear-gradient(120deg,$colorEsc,#0f172a); color:#fff; padding:28px 20px; }
    main { max-width:720px; margin:0 auto; padding:24px 20px 100px; }
    .card { background:#fff; border-radius:14px; padding:18px 20px;
            box-shadow:0 8px 24px rgba(15,23,42,.08); line-height:1.55; }
    code { background:#e2e8f0; padding:2px 6px; border-radius:6px; font-size:.9em; word-break:break-all; }
    .note { margin-top:14px; font-size:14px; color:#475569; }
    .warn { margin-top:12px; padding:10px 12px; background:#fff7ed; border-left:4px solid #f97316;
            border-radius:8px; font-size:13px; color:#9a3412; }
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0 0 6px;font-size:1.5rem;">$titleEsc</h1>
    <p style="margin:0;opacity:.9;">$subEsc</p>
  </header>
  <main>
    <div class="card">
      <p>Đây là <strong>website phòng khám giả lập</strong> (chỉ HTML). Widget SimlyDent được tải
        <strong>từ host SimlyDent</strong>, không host widget trên origin này.</p>
      <p class="note">
        <strong>site_key:</strong> <code>$skEsc</code><br/>
        <strong>widget:</strong> <code>$embedEsc</code><br/>
        <strong>api-base:</strong> <code>$apiEsc</code>
      </p>
      <p class="note">$peerEsc</p>
      <div class="warn">
        Origin = scheme + host + port. Path khác trên cùng host <em>không</em> tạo origin khác.
        Staff portal: mở trên SimlyDent host, không trên cổng clinic giả.
      </div>
    </div>
  </main>
  <script
    src="$embedEsc"
    data-site-key="$skEsc"
    data-api-base="$apiEsc"
    data-name="$titleEsc"
    data-color="$colorEsc"
    async></script>
</body>
</html>
"@
}

function Invoke-EmbedSessionProbe {
    param([string]$SiteKey, [string]$Origin)
    $body = (@{ siteKey = $SiteKey } | ConvertTo-Json -Compress)
    try {
        $r = Invoke-WebRequest -Method Post -Uri "$ApiBase/embed/session" `
            -Headers @{ Origin = $Origin } `
            -ContentType "application/json" -Body $body -UseBasicParsing
        return [int]$r.StatusCode
    }
    catch {
        if ($null -eq $_.Exception.Response) { throw }
        return [int]$_.Exception.Response.StatusCode
    }
}

function Test-FourWayOriginBinding {
    Write-Host ""
    Write-Host "=== 4-way origin binding (site_key <-> allowed origin) ===" -ForegroundColor Cyan
    Write-Host "ApiBase=$ApiBase"
    Write-Host "OriginA=$OriginA  OriginB=$OriginB"

    $cases = @(
        @{ Name = "Origin A + key A"; SiteKey = $SiteKeyA; Origin = $OriginA; Expect = 200 }
        @{ Name = "Origin B + key B"; SiteKey = $SiteKeyB; Origin = $OriginB; Expect = 200 }
        @{ Name = "Origin B + key A"; SiteKey = $SiteKeyA; Origin = $OriginB; Expect = 403 }
        @{ Name = "Origin A + key B"; SiteKey = $SiteKeyB; Origin = $OriginA; Expect = 403 }
    )

    $fail = 0
    foreach ($c in $cases) {
        $status = Invoke-EmbedSessionProbe -SiteKey $c.SiteKey -Origin $c.Origin
        $ok = ($status -eq $c.Expect)
        if ($ok) {
            $mark = "PASS"
            $color = "Green"
        }
        else {
            $mark = "FAIL"
            $color = "Red"
            $fail++
        }
        Write-Host ("  [{0}] {1}  expected={2} actual={3}" -f $mark, $c.Name, $c.Expect, $status) -ForegroundColor $color
    }

    if ($fail -gt 0) {
        Write-Host "4-way origin binding FAILED ($fail)." -ForegroundColor Red
        exit 1
    }
    Write-Host "4-way origin binding PASS (4/4)." -ForegroundColor Green
}

function New-Listener([int]$Port) {
    $prefix = "http://${HostName}:${Port}/"
    $l = [System.Net.HttpListener]::new()
    $l.Prefixes.Add($prefix)
    try {
        $l.Start()
    }
    catch {
        throw "Cannot bind $prefix — port in use or URL ACL missing. Try: netsh http add urlacl url=$prefix user=Everyone. $_"
    }
    return $l
}

function Write-HttpResponse([System.Net.HttpListenerResponse]$Response, [int]$Status, [string]$ContentType, [byte[]]$Bytes) {
    $Response.StatusCode = $Status
    $Response.ContentType = $ContentType
    $Response.ContentLength64 = $Bytes.Length
    $Response.Headers.Add("Cache-Control", "no-store")
    $Response.OutputStream.Write($Bytes, 0, $Bytes.Length)
    $Response.OutputStream.Close()
}

function Start-ClinicServers {
    $htmlA = Get-ClinicHtml -ClinicTitle $NameA `
        -ClinicSubtitle "Fake clinic website · clinic-a · port $PortA" `
        -SiteKey $SiteKeyA -Color $ColorA -ApiBaseUrl $ApiBase `
        -PeerNote "Peer isolation: Clinic B harness is $OriginB (different port = different origin)."
    $htmlB = Get-ClinicHtml -ClinicTitle $NameB `
        -ClinicSubtitle "Fake clinic website · clinic-b · port $PortB" `
        -SiteKey $SiteKeyB -Color $ColorB -ApiBaseUrl $ApiBase `
        -PeerNote "Peer isolation: Clinic A harness is $OriginA (different port = different origin)."

    $bytesA = [Text.Encoding]::UTF8.GetBytes($htmlA)
    $bytesB = [Text.Encoding]::UTF8.GetBytes($htmlB)

    $listenerA = New-Listener -Port $PortA
    $listenerB = New-Listener -Port $PortB

    Write-Host ""
    Write-Host "=== PR-E multi-origin clinic harness ===" -ForegroundColor Cyan
    Write-Host "Clinic A (fake site):  $OriginA/"
    Write-Host "Clinic B (fake site):  $OriginB/"
    Write-Host "Remote widget:         $EmbedJs"
    Write-Host "Remote API:            $ApiBase"
    Write-Host "Staff portal:          $StaffPortal  (login A1 / Demo@123)"
    Write-Host ""
    Write-Host "Open A in one browser tab, staff portal in another. Press Ctrl+C to stop." -ForegroundColor Yellow

    $worker = {
        param($Listener, $HtmlBytes, $ApiBaseUrl)
        while ($Listener.IsListening) {
            try {
                $ctx = $Listener.GetContext()
            }
            catch {
                break
            }
            try {
                $path = $ctx.Request.Url.AbsolutePath.TrimEnd('/')
                if ($path -eq "" -or $path -eq "/" -or $path -eq "/index.html") {
                    $ctx.Response.StatusCode = 200
                    $ctx.Response.ContentType = "text/html; charset=utf-8"
                    $ctx.Response.ContentLength64 = $HtmlBytes.Length
                    $ctx.Response.Headers.Add("Cache-Control", "no-store")
                    $ctx.Response.OutputStream.Write($HtmlBytes, 0, $HtmlBytes.Length)
                }
                else {
                    $msg = [Text.Encoding]::UTF8.GetBytes(
                        "Not found. This harness only serves / (fake clinic HTML). Widget is on $ApiBaseUrl.")
                    $ctx.Response.StatusCode = 404
                    $ctx.Response.ContentType = "text/plain; charset=utf-8"
                    $ctx.Response.ContentLength64 = $msg.Length
                    $ctx.Response.OutputStream.Write($msg, 0, $msg.Length)
                }
                $ctx.Response.OutputStream.Close()
            }
            catch {
                try { $ctx.Response.Abort() } catch { }
            }
        }
    }

    $psA = [powershell]::Create().AddScript($worker).AddArgument($listenerA).AddArgument($bytesA).AddArgument($ApiBase)
    $psB = [powershell]::Create().AddScript($worker).AddArgument($listenerB).AddArgument($bytesB).AddArgument($ApiBase)
    $hA = $psA.BeginInvoke()
    $hB = $psB.BeginInvoke()

    try {
        while ($true) {
            Start-Sleep -Seconds 1
            if ($hA.IsCompleted -or $hB.IsCompleted) {
                # Unexpected worker exit — surface errors if any
                break
            }
        }
    }
    finally {
        if ($listenerA.IsListening) { $listenerA.Stop() }
        if ($listenerB.IsListening) { $listenerB.Stop() }
        try { $listenerA.Close() } catch { }
        try { $listenerB.Close() } catch { }
        try { $psA.EndInvoke($hA) } catch { }
        try { $psB.EndInvoke($hB) } catch { }
        $psA.Dispose()
        $psB.Dispose()
    }
}

# --- main ---
$doProbe = $ProbeOnly -or $ProbeAndServe
$doServe = (-not $ProbeOnly)

if ($doProbe) {
    # Health + remote widget presence
    try {
        $h = Invoke-WebRequest -Uri "$ApiBase/health" -UseBasicParsing -TimeoutSec 20
        Write-Host "Health: $($h.StatusCode)" -ForegroundColor Green
    }
    catch {
        Write-Host "Health check failed for $ApiBase : $_" -ForegroundColor Red
        exit 1
    }
    try {
        $w = Invoke-WebRequest -Uri $EmbedJs -UseBasicParsing -TimeoutSec 20
        Write-Host "Remote embed.js: $($w.StatusCode) (len=$($w.RawContentLength))" -ForegroundColor Green
    }
    catch {
        Write-Host "Remote embed.js missing at $EmbedJs : $_" -ForegroundColor Red
        exit 1
    }
    Test-FourWayOriginBinding
}

if ($doServe -and -not $ProbeOnly) {
    if ($ProbeAndServe) {
        Write-Host ""
        Write-Host "Starting clinic host servers..." -ForegroundColor Cyan
    }
    Start-ClinicServers
}
elseif ($ProbeOnly) {
    exit 0
}
