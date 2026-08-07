# Media paths: Legacy recording vs Canonical consultation assets

## Canonical (product path — prefer)

| Asset | Kind | Catalog | Orchestration | Finalize |
|-------|------|---------|---------------|----------|
| Full-session audio | CallAudio | `IConsultationCatalog` / `media_assets` | `ConsultationAudioService` | `RecordingFinalizeService.ApplyMediaEgressStatusAsync` |
| Dental clip | DentalVideoClip | same | `DentalClipService` | same |
| Snapshot | Snapshot | same | `SnapshotService` | upload-complete + reconcile timeout |

- Storage keys: `MediaStorageKeys` (`clinic/{id}/calls/{call}/audio|videos|photos/...`)
- On call end: `ConsultationMediaLifecycleService.StopAllActiveMediaAsync`
- Webhook: **try media_assets first** (`Found=true`), else fall through to legacy ledger

## Legacy (DEPRECATED — still supported)

| Concern | Catalog | Orchestration | Finalize |
|---------|---------|---------------|----------|
| One composite MP4 per call | `IRecordingCatalog` / `recordings` | `RecordingOrchestrationService` (start/stop) | `RecordingFinalizeService.ApplyEgressStatusAsync` |

- Storage keys: `RecordingStorageKeys` / `IRecordingStorage.BuildKey`
- CallSession fields: `RecordingStatus`, `RecordingEgressId`, `RecordingStorageKey`, …
- UI Manager library still lists legacy catalog rows

## Invariants

1. **Recording/media failure ≠ call failure** — EndCall never depends on egress success.
2. **Webhook dual-catalog**: media first, then legacy (avoid double-finalize).
3. **Reconcile**: two loops in `RecordingReconcileService` — `RunLegacyRecordingReconcileAsync` + `RunCanonicalMediaReconcileAsync`.
4. Do **not** lower Egress `cpu_cost` to "fix" capacity issues.