# Production-Grade Architecture Refactor — SimlyDent LiveKit 1:1 Call & Media

## Phase 0 — Baseline Confirmed

| Item | Value |
|------|-------|
| VPS HEAD | `b9a80d28` (matches handoff SHA) |
| Branch | `main` |
| Containers | All 8 running (backend, frontend, gateway, livekit, egress, redis, postgres, minio) |
| Health | `{"status":"ok", ...featureMediaAssets:true}` |
| Dirty files | `Caddyfile.vps.runtime`, `start-vps.sh` (runtime config — preserved, not committed) |
| Untracked | 12 egress JSON files + 2 MP3s + clinic recordings + audit JSONL (all in `recordings/`) |
| Rollback SHA | `b9a80d28f26dcfedb965e3d25827f7465edfafbe` |

Refactor branch to create: `refactor/production-call-media`

---

## Current Architecture — Problem Map

### Frontend (169KB `main.js` — 3,960 lines)

The entire staff frontend is a single file containing **two mutually exclusive Vue 2 apps** selected by URL routing:

| Block | Lines | Responsibility |
|-------|-------|---------------|
| Globals/Utilities | L1–L1116 | Auth, formatters, API wrapper, video orientation normalization, WebRTC stats, photo capture |
| **Call Window App** | L1117–L2410 | LiveKit Room, media tracks, quality telemetry, dental clips, snapshots, recording, SignalR |
| **Portal App** | L2411–L3960 | Login, contacts, queue, call history, consultations, recordings manager, SignalR, popup management |

**Critical coupling issues:**
- LiveKit Room creation, event handling, camera/mic toggle, remote track attachment, and reconnect policy are all **inlined** inside the Call Window Vue instance methods (~900 lines of media orchestration)
- Business call lifecycle (accept/reject/end) is **interleaved** with LiveKit media lifecycle
- SignalR boilerplate is **duplicated** between both Vue apps
- Media mode resolution logic appears in **3 places**: `applyAuthoritativeMediaMode` (Call Window), `mediaModeFromCall` (Portal), and `frame.js` (embed)
- Quality telemetry (~200 lines) is embedded in the call window

### Embed/Widget (`frame.js` — 1,079 lines)

A separate Vanilla JS IIFE implementing a **parallel, independent** LiveKit client:
- Loads LiveKit UMD from CDN (same version 2.21.0)
- Has its own room creation, track publication, camera/mic toggle, remote track attachment
- Has its own Safari audio unlock, disconnect handling, reconnect state
- Has its own photo capture/upload logic
- Uses polling instead of SignalR for call state

**Duplicated with main.js:** ~15 distinct functional areas including media mode resolution, join flow, camera handling, microphone handling, remote track attachment, audio autoplay unlock, disconnect policy, photo capture

### Backend (`Program.cs` — 1,613 lines)

The composition root contains **43 endpoint definitions** inline with substantial orchestration logic:

| Endpoint Group | Count | Lines | Inline Logic? |
|---------------|-------|-------|--------------|
| Health | 1 | L160 | Minimal |
| Embed session/calls | 6 | L177–L340 | Moderate |
| Auth | 4 | L344–L375 | Minimal |
| Directory/Presence | 3 | L367–L397 | Minimal |
| Queue/Agents | 4 | L388–L565 | Moderate |
| Calls (CRUD + accept/reject/end/token) | 8 | L567–L815 | Heavy |
| Recording lifecycle | 7 | L817–L1275 | **Very Heavy** (recording/start is 120+ lines) |
| Recording storage/download | 4 | L1277–L1468 | Heavy |
| Embed consent | 1 | L1470 | Moderate |
| Quality telemetry | 3 | L1499–L1560 | Moderate |

**Heaviest inline endpoint**: `POST /api/calls/{id}/recording/start` (~120 lines of egress orchestration logic)

### Backend Services — Legacy/Canonical Overlap

The system runs **two parallel media models** simultaneously:

| Concern | Legacy (`RecordingCatalog`) | Canonical (`ConsultationCatalog`) |
|---------|---------------------------|----------------------------------|
| Model | 1 recording per call | N media assets per consultation |
| Tables | `recordings` | `consultation_sessions` + `media_assets` + `media_objects` |
| State machine | Requested→Recording→Finalizing→Ready | Identical states but multi-asset |
| Size | 46KB / 1015 lines | 63KB / 1372 lines |
| Used by | Legacy recording endpoints | ConsultationAudioService, DentalClipService, SnapshotService |
| Finalization | `RecordingFinalizeService` path A | `RecordingFinalizeService` path B |
| Reconciliation | `RecordingReconcileService` loop A | `RecordingReconcileService` loop B |

**God-object concern**: `CallSession` is used as a sync root (`lock(call.SyncRoot)`) by CallDispatcher, ConsultationAudioService, DentalClipService, and RecordingFinalizeService simultaneously.

---

## Proposed Changes

### Phase 1 — Pure Contracts & Helpers

Extract zero-dependency utilities from `main.js` into importable modules. No DOM, no LiveKit, no Vue dependencies.

#### [NEW] [constants.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/shared/constants.js)
- `AUTH_TOKEN_KEY`, `AUTH_USER_KEY`, call statuses, recording modes, media mode values
- API_URL resolution

#### [NEW] [auth.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/shared/auth.js)
- `getAccessToken`, `setAuthSession`, `clearAuthSession`, `readCachedUser`, `authHeaders`

#### [NEW] [api-client.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/shared/api-client.js)
- `apiFetch` wrapper with auth headers injection

#### [NEW] [call-helpers.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/shared/call-helpers.js)
- `normalizeMediaMode`, `isTerminalStatus`, `clinicIdOf`, `isEmbedVisitorId`, `peerLabel`, `visitorShortCode`
- `callStatusVi`, `recordingModeLabel`, `formatViDateTime`, `formatWaitSeconds`

#### [NEW] [storage-helpers.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/shared/storage-helpers.js)
- Safe sessionStorage/localStorage read/write wrappers

#### [MODIFY] [main.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/main.js)
- Replace inline implementations with imports from shared modules
- No behavior change — purely structural

**Verification**: `npm run build` must succeed. No runtime changes.

---

### Phase 2 — LiveKit MediaEngine & Adapter (Highest Priority)

Extract the core LiveKit integration from the Call Window Vue instance into a reusable media engine.

#### [NEW] [livekit-adapter.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/media/livekit-adapter.js)
- Thin wrapper around LiveKit SDK: Room creation, connect, disconnect
- Event subscription/forwarding (all 15 RoomEvents)
- Track creation via `createLocalTracks`
- No business logic — pure SDK adapter

#### [NEW] [media-engine.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/media/media-engine.js)
- `createCallRoom(config)` → returns engine instance
- `connect(url, token, options)` → connect to room
- `disconnectMedia()` → clean disconnect
- `ensureCameraEnabled(bool)` → safe camera toggle with publication reconciliation
- `ensureMicrophoneEnabled(bool)` → mic toggle
- `attachRemoteTrack(track, container)` → DOM attachment
- `startRemoteAudioPlayback()` → Safari autoplay unlock
- `getLocalMediaState()` → { cameraEnabled, micEnabled, hasLocalVideo, hasLocalAudio }
- Events: Connected, Reconnecting, Reconnected, Disconnected, LocalTrack*, RemoteTrack*, TrackMuted/Unmuted, DataReceived
- **Critical invariant**: Disconnected event ≠ business hangup — engine reports connection state only

#### [NEW] [media-state.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/media/media-state.js)
- Connection state enum: `idle`, `joining`, `connected`, `reconnecting`, `rejoin-required`, `error`
- Media state tracking (reactive-friendly plain object)

#### [MODIFY] [main.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/main.js)
- Call Window Vue becomes a consumer of MediaEngine events/state
- Remove ~500 lines of inlined LiveKit orchestration
- Call controller methods (`joinRoom`, `toggleCamera`, `toggleMicrophone`, `endCall`) delegate to MediaEngine
- Camera ensure/reconcile moved from Vue methods to engine internals

**Verification**: Deploy frontend to VPS. Run R1–R8 regression subset (audio mode, video mode, camera toggle ×5, reopen, disconnect, remote audio, hangup).

---

### Phase 3 — Frontend Surface Separation

Split the two Vue apps into separate entry-like modules while keeping them in the same Vite bundle (single `index.html` entry point).

#### [NEW] [portal/portal-app.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/app/portal/portal-app.js)
- Portal Vue instance definition (login, contacts, queue, call history, consultation library)
- SignalR connection for portal context
- Popup window management

#### [NEW] [portal/portal-controller.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/app/portal/portal-controller.js)
- `startCall`, `acceptCall`, `rejectCall`, `reopenCallWindow` orchestration
- Queue management actions

#### [NEW] [call-window/call-window-app.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/app/call-window/call-window-app.js)
- Call Window Vue instance definition
- Consumes MediaEngine for all LiveKit interaction
- Quality telemetry collection

#### [NEW] [call-window/call-controller.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/app/call-window/call-controller.js)
- `joinRoom`, `endCall`, `toggleCamera`, `toggleMic`, `toggleDentalClip`, `requestPhoto`
- Window lifecycle: beforeunload, BroadcastChannel

#### [NEW] [domain/consultation/dental-clips.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/consultation/dental-clips.js)
- Dental clip start/stop API calls

#### [NEW] [domain/consultation/snapshots.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/consultation/snapshots.js)
- Photo capture logic, upload handling

#### [NEW] [domain/quality/telemetry.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/quality/telemetry.js)
- `readTrackStats`, `clientEnvironment`, `updateQualityStats` — currently ~200 lines in main.js

#### [MODIFY] [main.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/main.js)
- Becomes a thin router: detects URL path, imports and mounts appropriate app
- Retains the HTML template strings (or extracts them to template constants)
- Target: <200 lines

**Verification**: Build + deploy frontend. All routes must work: `/` (login), portal, `/call/{id}`. Reopen behavior must remain correct. R1–R8 + R13.

---

### Phase 4 — Backend Endpoint/Application Refactor

#### [NEW] [Endpoints/HealthEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/HealthEndpoints.cs)
- `/health` endpoint

#### [NEW] [Endpoints/AuthEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/AuthEndpoints.cs)
- `/api/auth/accounts`, `/api/auth/login`, `/api/auth/me`

#### [NEW] [Endpoints/EmbedEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/EmbedEndpoints.cs)
- All `/embed/*` endpoints (session, calls CRUD, token, cancel, end, consent)

#### [NEW] [Endpoints/CallEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/CallEndpoints.cs)
- `/api/calls/*` (CRUD, accept, reject, cancel, end, token, active)
- Thin — delegates to `CallDispatcher` and `CallEndService`

#### [NEW] [Endpoints/QueueEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/QueueEndpoints.cs)
- `/api/queue`, `/api/queue/calls`, `/api/agents/*`

#### [NEW] [Endpoints/RecordingEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/RecordingEndpoints.cs)
- `/api/calls/{id}/recording/*` — **extract orchestration to an application service**
- `/api/recordings` (list/download/delete)

#### [NEW] [Endpoints/WebhookEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/WebhookEndpoints.cs)
- `/api/livekit/webhook`

#### [NEW] [Endpoints/QualityEndpoints.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Endpoints/QualityEndpoints.cs)
- `/api/calls/{id}/quality/*`

#### [NEW] [Application/RecordingOrchestrationService.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Application/RecordingOrchestrationService.cs)
- Extract the ~120-line recording/start endpoint logic
- Extract recording/stop logic
- Contains the heavy egress orchestration currently inline in Program.cs

#### [MODIFY] [Program.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Program.cs)
- Becomes composition root only: DI registration, middleware, route group mapping
- All endpoint lambdas removed, replaced with `app.MapXxxEndpoints()` extension calls
- Target: <200 lines

**Verification**: `dotnet build`. Deploy backend. `curl /health`. Run R8, R9, R10, R11, R12.

---

### Phase 5 — Consultation/Media Orchestration Cleanup

#### [MODIFY] [RecordingFinalizeService.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingFinalizeService.cs)
- Separate legacy finalize path from canonical media asset finalize path
- Document which path handles what

#### [MODIFY] [RecordingReconcileService.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingReconcileService.cs)
- Consolidate the two scan loops where possible
- Document the legacy loop with DEPRECATED classification

#### [MODIFY] [RecordingStorage.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingStorage.cs)
- Extract `MediaStorageKeys` to a shared location if needed
- Document legacy vs canonical key generators

**Verification**: `dotnet build`. Deploy backend. R9, R10, R11 (media lifecycle).

---

### Phase 6 — Embed Alignment

#### [NEW] [domain/media/media-primitives.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/domain/media/media-primitives.js)
- Shared lower-level functions that **both** main.js and frame.js can use:
  - `acquireLocalTracks(preferredMedia)` — progressive device fallback
  - `attachRemoteAudioTrack(audioTrack, container)` — Safari-safe audio element creation
  - `attachRemoteVideoTrack(videoTrack, container)` — video element attachment
  - `startAudioUnlock(room, container)` — one-time click listener for autoplay
  - `normalizeMediaModeValue(value)` — shared mode normalization

#### [MODIFY] [frame.js](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/public/widget/frame.js)
- Since embed loads via `<script>` (not ES modules), create a **build step** to bundle media-primitives as a UMD sidecar, OR:
- **Alternative**: Duplicate the shared primitives into frame.js but mark them with `// @shared-from: media-primitives.js` annotations for future unification
- Preserve all visitor behavior: audio/video modes, camera toggle, remote audio, reconnect ≠ call-end

> [!IMPORTANT]
> The embed runs in an iframe with a `<script>` tag — it cannot directly import ES modules from the Vite bundle. The pragmatic Phase 6 approach is either: (a) create a separate Vite entry that builds a UMD bundle for widget use, or (b) keep frame.js as a documented adapter that copies shared logic. Option (a) is cleaner but requires a build pipeline change. Option (b) is safer for this refactor.

**Verification**: Test embed in browser with demo-a.html. R7 (visitor audio), camera toggle, disconnect behavior.

---

### Phase 7 — Configuration / Observability / Error Boundaries

#### Backend Configuration

#### [NEW] [Infrastructure/Options.cs](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Infrastructure/Options.cs)
- `LiveKitOptions` (API key, secret, HTTP URL)
- `EgressOptions` (encoding mode, presets, timeouts)
- `StorageOptions` (S3 endpoint, bucket, keys, region)
- `RecordingOptions` (finalize timeout, reconcile interval, retention days)
- Startup validation for required values

#### [MODIFY] Services consuming `IConfiguration` / `Environment.GetEnvironmentVariable`
- Inject typed options instead
- Incremental — one service at a time

#### Frontend Observability

#### [MODIFY] Call Window app
- Gate `rtLog` behind a debug flag (e.g., `sessionStorage.getItem('debug') === '1'`)
- Categorize errors: business failure, media permission, network/reconnect, recording failure, storage failure
- Never log JWTs or presigned URLs

**Verification**: Build both. Deploy. Spot-check logs for no leaked secrets.

---

### Phase 8 — Legacy Classification / Tests / Architecture Docs

#### [NEW] [docs/architecture-call-media.md](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/docs/architecture-call-media.md)
- Business call flow (Queued → Ringing → Accepted → Ended)
- Browser media flow (MediaEngine → LiveKit adapter → Room)
- CallAudio lifecycle (consent → Egress → storage → finalize)
- DentalVideoClip lifecycle
- Snapshot lifecycle
- Manager read path
- State machine diagrams (business call, media connection, CallAudio, DentalClip, Snapshot)
- Dependency map
- Infrastructure capacity boundary (2-vCPU lab limitation)

#### [NEW] [evidence/refactor-20260807.md](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/evidence/refactor-20260807.md)
- Starting SHA, branch, rollback SHA
- Phase-by-phase changes with commits
- Build results, deployment results
- Regression results (R1–R14)
- Legacy classification inventory
- Remaining debt (code, infrastructure, security, capacity)

#### Legacy Classification (in architecture doc)
| Component | Classification | Canonical Replacement | Removal Condition |
|-----------|---------------|----------------------|-------------------|
| `RecordingCatalog` | DEPRECATED | `ConsultationCatalog` | All callers migrated to media asset model |
| `RecordingFinalizeService` legacy path | DEPRECATED | Same service, canonical path | Legacy `RecordingCatalog` removed |
| `RecordingReconcileService` legacy loop | DEPRECATED | Same service, canonical loop | Legacy `RecordingCatalog` removed |
| `RecordingModels.cs` | DEPRECATED | `ConsultationModels.cs` | Legacy recording endpoints removed |
| `/api/recordings` list endpoint | KEEP (compatibility) | `/api/consultations` | Manager UI fully migrated |
| `/api/calls/{id}/recording/*` | KEEP (compatibility) | Future media-first API | Staff UI fully migrated to media model |

---

## Open Questions

> [!IMPORTANT]
> **Embed build strategy (Phase 6)**: Should we add a second Vite entry point to build media-primitives as a UMD bundle for the widget iframe? This gives clean shared code but adds build complexity. The alternative is documented duplication. This is the biggest architectural decision for Phase 6.

> [!IMPORTANT]
> **Legacy recording endpoint removal scope**: The legacy recording endpoints are still used by the staff portal for listing/downloading recordings. Should Phase 5 or Phase 8 migrate the portal UI to use the consultation media API exclusively, allowing us to mark legacy endpoints as DEPRECATED? Or keep both paths for this refactor?

---

## Verification Plan

### Build Gates
- After each frontend phase: `cd frontend && npm run build`
- After each backend phase: `cd backend && dotnet build`

### VPS Deployment
- Frontend: `docker compose -f docker-compose.vps.yml up -d --build frontend`
- Backend: `docker compose -f docker-compose.vps.yml up -d --build backend`
- Health check: `curl -sk https://103.28.32.118.sslip.io/health`

### Regression Suite
| ID | Test | Critical Phase |
|----|------|---------------|
| R1 | Audio call initial mode authority | P2, P3 |
| R2 | Video call initial mode authority | P2, P3 |
| R3 | Audio ↔ Video toggle ×5/×10 | P2, P3 |
| R4 | Both participants toggle independently | P2 |
| R5 | Reopen call window | P3 |
| R6 | Reconnect (network interruption) | P2, P6 |
| R7 | Visitor/embed remote audio | P6 |
| R8 | Intentional hangup | P2, P3, P4 |
| R9 | Automatic CallAudio | P4, P5 |
| R10 | Dental clip lifecycle | P4, P5 |
| R11 | Snapshot lifecycle | P4, P5 |
| R12 | Manager consultation history | P4, P5 |
| R13 | Refresh/reopen call UI | P3 |
| R14 | Backend restart survival | P4 |

### Capacity Observation (Post-Phase 8)
```bash
docker stats
vmstat 1
```
For: Realtime only, Realtime + CallAudio, Realtime + CallAudio + DentalVideoClip

---

## Commit Strategy

```
refactor(frontend): extract shared auth, API, and call helpers
refactor(media): extract LiveKit adapter and media engine
refactor(frontend): separate portal and call window applications
refactor(backend): extract endpoint groups from Program.cs
refactor(backend): extract recording orchestration service
refactor(media): clarify consultation media service boundaries
refactor(widget): align embed with shared media primitives
refactor(config): introduce typed backend options
test(call): add media mode and disconnect regression coverage
docs(architecture): document canonical call/media architecture
```
