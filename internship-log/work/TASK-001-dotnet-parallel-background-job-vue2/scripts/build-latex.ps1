param(
    [switch]$OpenPdf
)

$taskRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$latexDirectory = Join-Path $taskRoot 'docs\latex'
$outputDirectory = Join-Path $taskRoot 'output'
$mainFile = Join-Path $latexDirectory 'main.tex'
$builtPdfFile = Join-Path $outputDirectory 'main.pdf'
$pdfFile = Join-Path $outputDirectory 'TASK-001-Bao-Cao-Nghien-Cuu-Ky-Thuat.pdf'

if (-not (Get-Command latexmk -ErrorAction SilentlyContinue)) {
    throw 'Không tìm thấy latexmk. Hãy cài TeX Live hoặc MiKTeX có latexmk.'
}

New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null

Push-Location $latexDirectory
try {
    & latexmk -xelatex -interaction=nonstopmode -halt-on-error "-outdir=$outputDirectory" $mainFile
    if ($LASTEXITCODE -ne 0) {
        throw "Build LaTeX thất bại với exit code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}

Move-Item -LiteralPath $builtPdfFile -Destination $pdfFile -Force
Write-Output "Đã tạo: $pdfFile"

if ($OpenPdf -and (Test-Path -LiteralPath $pdfFile)) {
    Start-Process -FilePath $pdfFile
}
