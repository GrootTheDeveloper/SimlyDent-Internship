# Media paths: Legacy recording vs Canonical consultation assets

## Product rules (current)

| Asset | Who starts | How many / call | Consent |
|-------|------------|-----------------|---------|
| **CallAudio** (full session) | **Always auto** after Accept (+ retry on token join) | One active / one Ready | **Not required** (`FEATURE_AUTO_CALL_AUDIO` kill-switch only) |
| **DentalVideoClip** | Staff button start/stop | **Many sequential** (one active at a time) | Not required (staff action is the gate) |
| **Snapshot** | Staff request / patient capture | Many | N/A |
| Legacy full-call MP4 | **Retired from UI** (backend APIs may still exist) | — | — |

Manager library UI: **only** `/api/consultations` (canonical). Login **A-MGR**.  
Legacy `/api/recordings` + red record button removed from SPA (backend kept for finalize/webhook safety until a later cleanup PR).

## Canonical (product path — prefer)

| Asset | Kind | Catalog | Orchestration | Finalize |
|-------|------|---------|---------------|----------|
| Full-session audio | CallAudio | `IConsultationCatalog` / `media_assets` | `ConsultationAudioService` | `RecordingFinalizeService.ApplyMediaEgressStatusAsync` |
| Dental clip | DentalVideoClip | same | `DentalClipService` | same |
| Snapshot | Snapshot | same | `SnapshotService` | upload-complete + reconcile timeout |

- Storage keys: `MediaStorageKeys` (`clinic/{id}/calls/{call}/audio|videos|photos/...`)
- On call end: `ConsultationMediaLifecycleService.StopAllActiveMediaAsync`
- Webhook: **try media_assets first** (`Found=true`), else fall through to legacy ledger
- Auto audio hooks: Accept + `POST /api/calls/{id}/token` (second chance when participants join)

## Legacy (DEPRECATED — still supported)

| Concern | Catalog | Orchestration | Finalize |
|---------|---------|---------------|----------|
| One composite MP4 per call | `IRecordingCatalog` / `recordings` | `RecordingOrchestrationService` (start/stop) | `RecordingFinalizeService.ApplyEgressStatusAsync` |

- Storage keys: `RecordingStorageKeys` / `IRecordingStorage.BuildKey`
- CallSession fields: `RecordingStatus`, `RecordingEgressId`, `RecordingStorageKey`, …
- **UI retired** — do not surface in manager SPA; prefer CallAudio + clips

## Invariants

1. **Recording/media failure ≠ call failure** — EndCall never depends on egress success.
2. **Webhook dual-catalog**: media first, then legacy (avoid double-finalize).
3. **Reconcile**: two loops in `RecordingReconcileService` — `RunLegacyRecordingReconcileAsync` + `RunCanonicalMediaReconcileAsync`.
4. Do **not** lower Egress `cpu_cost` to "fix" capacity issues.
## Embed widget media (Phase 6)

- Staff SPA: \src/domain/media/media-primitives.js\ (ESM)
- Embed iframe: \public/widget/media-primitives.js\ (IIFE → \window.SimlyDentMediaPrimitives\)
- \rame.html\ loads media-primitives.js **before** frame.js
- Keep algorithms in sync (@shared-pair comments)
- frame.js falls back if IIFE missing
