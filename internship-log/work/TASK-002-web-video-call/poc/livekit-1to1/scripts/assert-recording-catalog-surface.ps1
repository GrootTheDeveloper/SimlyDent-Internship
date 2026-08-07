# Structural + contract assertions for recording catalog surface shipped in backend.
# Does not require local Docker. Fails if Program/Catalog/compose drift from plan.
$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
# script is in poc/livekit-1to1/scripts → root is livekit-1to1
$poc = Split-Path $PSScriptRoot -Parent
$prog = Join-Path $poc "backend\Program.cs"
$cat = Join-Path $poc "backend\RecordingCatalog.cs"
$compose = Join-Path $poc "docker-compose.vps.yml"
foreach ($f in @($prog, $cat, $compose)) {
  if (-not (Test-Path $f)) { throw "Missing required file: $f" }
}
$progText = Get-Content $prog -Raw
$catText = Get-Content $cat -Raw
$composeText = Get-Content $compose -Raw

$checks = @(
  @{ Name = "health exposes catalog fields"; Ok = $progText -match 'recordingCatalog' -and $progText -match 'recordingStorage' },
  @{ Name = "IRecordingCatalog registered"; Ok = $progText -match 'IRecordingCatalog' },
  @{ Name = "EnsureSchema on startup"; Ok = $progText -match 'EnsureSchemaAsync' },
  @{ Name = "GET /api/recordings uses catalog"; Ok = $progText -match 'MapGet\("/api/recordings"' -and $progText -match 'ListByClinicAsync' },
  @{ Name = "PostgresRecordingCatalog exists"; Ok = $catText -match 'class PostgresRecordingCatalog' },
  @{ Name = "recordings + recording_objects schema"; Ok = $catText -match 'CREATE TABLE IF NOT EXISTS recordings' -and $catText -match 'recording_objects' },
  @{ Name = "compose has postgres service"; Ok = $composeText -match '(?m)^\s*postgres:\s*$' },
  @{ Name = "compose RECORDING_CATALOG"; Ok = $composeText -match 'RECORDING_CATALOG' },
  @{ Name = "ledger insert before egress path"; Ok = $progText -match 'InsertRequestedAsync' },
  @{ Name = "async stop RequestStopAsync"; Ok = $progText -match 'RequestStopAsync' -and $progText -notmatch 'StopRecordingAsync' },
  @{ Name = "livekit webhook route"; Ok = $progText -match '/api/livekit/webhook' },
  @{ Name = "FinalizeService registered"; Ok = $progText -match 'RecordingFinalizeService' },
  @{ Name = "Reconcile hosted"; Ok = $progText -match 'RecordingReconcileService' },
  @{ Name = "TryMarkFinalizing with egress"; Ok = $catText -match 'TryMarkFinalizingAsync' -and $catText -match 'finalizing_started_at' },
  @{ Name = "terminal_seen_at clock"; Ok = $catText -match 'terminal_seen_at' },
  @{ Name = "TryMarkFailed only active states"; Ok = $catText -match "status IN \(@s1, @s2, @s3\)" -or $catText -match 'Requested or Recording or Finalizing' }
)
$failed = @()
foreach ($c in $checks) {
  $mark = if ($c.Ok) { "PASS" } else { "FAIL"; $failed += $c.Name }
  Write-Host ("[{0}] {1}" -f $mark, $c.Name)
}
if ($failed.Count -gt 0) {
  throw ("assert-recording-catalog-surface failed: " + ($failed -join "; "))
}
Write-Host "ALL_PASS count=$($checks.Count)"
