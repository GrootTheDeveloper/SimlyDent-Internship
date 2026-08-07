# Architecture ? Call & Media (SimlyDent LiveKit 1:1)

**Branch:** `refactor/production-call-media`  
**Doc version:** Phase 8 handoff  
**Related:** [media-paths.md](./media-paths.md), [vps-deploy.md](./vps-deploy.md)

## 1. Surfaces

| Surface | Entry | Role |
|---------|-------|------|
| Portal | `/` ? `app/portal/portal-app.js` | Login, contacts, queue, manager library, open call popup |
| Call window | `/call/:id` ? `app/call-window/call-window-app.js` | Live media via MediaEngine |
| Embed widget | `/widget/frame.html` | Visitor iframe; `media-primitives.js` IIFE + `frame.js` |
| Backend API | Caddy ? `backend:8080` | Auth, calls, recording, consultation media, webhooks |
| LiveKit | SFU + optional Egress | Realtime A/V + file egress |

## 2. Business call lifecycle

```text
Queued ??? Ringing ??? Accepted ??? Ended
              ?            ?
           Rejected     Cancel (from Ringing)
           Timeout/NoAgent/Closed (queue paths)
```

- **Authoritative state:** `CallSession` in-memory (`ConcurrentDictionary`) + SignalR `CallUpdated`.
- **Not the same as media:** WebRTC disconnect ? business `Ended`.
- **Initial media mode:** `CallSession.InitialMediaMode` = `Audio|Video` (set at create; both parties read `CallView.initialMediaMode`).
- **Restart debt:** CallSession is **not** durable ? API restart drops active calls (R14). Postgres holds media catalogs only.

## 3. Browser media lifecycle (MediaEngine)

```text
idle ? joining ? connected ? reconnecting
                 ?
                 ?? error ? rejoinMedia()
                 ?? intentional leave ? hangup API + disconnect
```

```text
Vue (call-window)
  ? MediaEngine.connect / ensureCameraEnabled / ensureMicrophoneEnabled
    ? livekit-adapter (Room, tracks, publish)
      ? LiveKit SFU
```

Invariants:

1. Camera/mic UI reconciles from **LiveKit publications**, not optimistic Vue flags first.
2. `Disconnected` event does **not** end the business call unless hangup or terminal status.
3. Safari autoplay: `startAudio` / tap-to-unmute (`media-primitives` + safe fallbacks).

## 4. Consultation media (canonical)

```text
Consultation session (1:1 call)
??? CallAudio (auto after consent) ?? Egress room composite audio_only
??? DentalVideoClip ? N (staff start/stop) ?? Egress track composite
??? Snapshot ? N (staff request ? patient capture ? upload)
```

| Asset | Orchestration | Finalize |
|-------|---------------|----------|
| CallAudio | `ConsultationAudioService` | `ApplyMediaEgressStatusAsync` |
| DentalVideoClip | `DentalClipService` | same |
| Snapshot | `SnapshotService` | upload-complete + reconcile timeout |

Storage keys: `MediaStorageKeys` (`clinic/.../audio|videos|photos/...`).

Call end: `ConsultationMediaLifecycleService.StopAllActiveMediaAsync` (best-effort; never blocks End).

## 5. Legacy recording (DEPRECATED)

Single composite MP4 per call via `IRecordingCatalog` + `RecordingOrchestrationService` start/stop.  
Webhook: **canonical media first**, then legacy ledger if `Found=false`.  
See [media-paths.md](./media-paths.md).

## 6. Backend composition

```text
Program.cs          DI + middleware + Map*Endpoints + hub
Endpoints/*         HTTP surface
Application/*       RecordingOrchestrationService (legacy)
Options/*           LiveKit, Auth, Features, RecordingRuntime
domain services     Dispatcher, Finalize, Reconcile, Egress, catalogs
```

## 7. Frontend composition

```text
main.js             thin router (dynamic import)
shared/*            auth, api, constants, safe-log
domain/media/*      MediaEngine, adapter, utils, media-primitives
domain/consultation snapshots
app/portal          staff UI
app/call-window     media UI
public/widget/*     embed (IIFE primitives + frame.js)
```

## 8. Capacity (lab VPS)

- **2 vCPU / ~4 GB RAM** shared SFU + Egress Chrome + Postgres + API.
- Concurrent auto CallAudio + dental/video egress is **capacity-limited**.
- `cpu_cost` in egress.yaml is **admission accounting only**, not real CPU reduction.
- Prefer dedicated Egress node or ?4 vCPU for product concurrency.

## 9. Security notes (PoC)

- Demo JWT + passwords; secrets via env; `REQUIRE_STRICT_SECRETS` for production-like fail-fast.
- `safe-log.js` redacts JWT / presigned URLs in browser console.
- Never commit `.env` or full presigned URLs in evidence.
