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

    [string]$ColorA = "#F26522",
    [string]$ColorB = "#1B3587",

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

    # Landing style tokens from simlydent.vn (orange / navy)
    @"
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>$titleEsc — multi-origin demo</title>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {
      --orange:#F26522; --navy:#1B3587; --body:#3D3D4E; --muted:#7A7A8C;
      --border:#E8E8F0; --bg:#fff; --bg-alt:#F7F8FC; --bg-orange:#FFF4EE;
      --accent:$colorEsc;
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Be Vietnam Pro",system-ui,sans-serif;background:var(--bg);color:var(--body);font-size:17px;line-height:1.6}
    .nav{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);background:rgba(255,255,255,.94);position:sticky;top:0}
    .brand{display:flex;align-items:center;gap:10px;font-weight:800;color:var(--navy);font-size:15px}
    .mark{width:36px;height:36px;border-radius:10px;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800}
    .hero{padding:48px 20px 40px;background:radial-gradient(700px 300px at 90% 0%,rgba(242,101,34,.12),transparent 55%),var(--bg)}
    .wrap{max-width:720px;margin:0 auto}
    h1{margin:0 0 12px;font-size:clamp(26px,4vw,36px);line-height:1.15;letter-spacing:-.03em;color:var(--navy);font-weight:800}
    h1 em{font-style:normal;color:var(--accent)}
    .lead{margin:0 0 18px;color:var(--muted);max-width:42ch}
    .card{background:#fff;border:1px solid var(--border);border-radius:16px;padding:18px 20px;box-shadow:0 8px 28px rgba(27,53,135,.08);margin-top:20px}
    .card p{margin:0 0 10px;font-size:14px;color:var(--muted)}
    code{background:var(--bg-alt);border:1px solid var(--border);padding:1px 6px;border-radius:6px;font-size:12px;color:var(--navy);word-break:break-all}
    .pill{display:inline-flex;padding:6px 12px;border-radius:999px;background:var(--bg-orange);color:var(--orange);font-size:12px;font-weight:700;margin-bottom:14px}
    .note{font-size:13px;color:var(--muted);margin-top:8px}
  </style>
</head>
<body>
  <div class="nav">
    <div class="brand"><div class="mark">S</div>$titleEsc</div>
  </div>
  <section class="hero">
    <div class="wrap">
      <div class="pill">Multi-origin harness · widget remote</div>
      <h1>$titleEsc<br /><em>Gọi tư vấn video</em></h1>
      <p class="lead">$subEsc Website giả lập — bấm nút góc phải để mở widget (tải từ host SimlyDent).</p>
      <div class="card">
        <p><strong>site_key:</strong> <code>$skEsc</code></p>
        <p><strong>api-base:</strong> <code>$apiEsc</code></p>
        <p><strong>widget:</strong> <code>$embedEsc</code></p>
        <p class="note">$peerEsc</p>
        <p class="note">Origin = scheme + host + port. Path khác trên cùng host <em>không</em> tạo origin khác.</p>
      </div>
    </div>
  </section>
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
