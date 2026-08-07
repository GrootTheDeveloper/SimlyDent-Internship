# Consultation Media System — Implementation Plan v2 (Revised)

> Senior review verdict: **Approve with required changes**.
> This is the corrected plan addressing all four blockers and supporting issues.

---

## Summary of Changes from v1

| Area | v1 Issue | v2 Fix |
|---|---|---|
| DB concurrency | Check-then-insert (race) | Partial unique indexes enforce at DB level |
| AudioOnly Egress | Sent `layout:"grid"` in audio-only request | Separate `StartRoomAudioRecordingAsync`, no layout, `.mp3` output |
| TrackComposite contract | `video_track_ids[]` + `participant_identity` (wrong) | Singular `video_track_id`, no participant_identity |
| Snapshot command | Staff client `publishData` (broadcast, weak auth) | Backend `RoomService.SendData` targeted to patient identity |
| Patient upload auth | Any same-clinic confirms upload | Bound to `source_participant_id`; HEAD + size + MIME validation |
| Physical metadata | Duplicated on asset and object | `media_assets` = lifecycle; `media_objects` = physical metadata only |
| Fire-and-forget | `_ = asyncTask` for media lifecycle | Bounded await best-effort, log failures, never fail call |
| sequence_no | Generated outside transaction | Deferred to `ORDER BY started_at`; no persisted seq assignment |
| Call end scope | Only stopped audio | `ConsultationMediaLifecycleService.StopAllActiveMediaAsync` |
| Finalize dual-catalog | Changed=false ambiguous | `FinalizeMediaResult` has `Found + Changed + NewStatus` |
| Historical identity | Joined in-memory CallSession | Snapshot `patient_display_name`, `staff_display_name` in DB |
| Manager DELETE | Synchronous object delete | State machine: Ready → DeletePending only |
| Thumbnail | Modeled but no producer | MVP: Original-only; thumbnail deferred |
| Manager legacy | Old recordings disappear | Legacy compatibility section in UI |
| Endpoint split | All in Program.cs | `ConsultationEndpoints.cs` + `MediaEndpoints.cs` |
| roomAdmin grant | Not in token | `CreateRoomAdminToken(roomName)` added to `LiveKitTokenService` |

---

## Infrastructure Already in Place — Reuse Unchanged

```
PostgreSQL recordings / recording_objects    ← keep, additive migration only
Requested → Recording → Finalizing → Ready  ← reuse state machine pattern
Failed / DeletePending / Deleted            ← reuse
LiveKit Egress start/stop                   ← reuse + extend
Webhook finalize path                       ← extend (dual-catalog)
Reconcile fallback                          ← extend (dual-catalog)
IRecordingStorage (Local + S3)              ← reuse + add CreatePresignedPutUrl
HeadObject / ExistsAsync before Ready       ← reuse pattern
Presigned GET                               ← reuse
Manager clinic authorization                ← reuse
Retention sweep                             ← extend to media_assets
Audit                                       ← extend with new events
```

---

## Invariants (Unchanged)

```
Recording/media failure ≠ call failure
Ready only when physical object confirmed exists
Postgres = metadata source of truth
Object Storage = media bytes
Client does not choose clinic_id / storage_key
Cross-clinic access → 404
No S3 credentials to frontend
```

---

## User Review Required

> [!WARNING]
> **DB concurrency is now enforced by partial unique indexes, not service code alone.** The schema includes database-level constraints that prevent double-click or concurrent start races. These must be applied before the service code is written.

> [!IMPORTANT]
> **`roomAdmin` grant added to LiveKit token.** The existing `CreateRoomRecordToken` only has `roomRecord + roomCreate`. A new `CreateRoomAdminToken(roomName)` is needed for: RoomService ListParticipants (track resolution for dental clips) and RoomService SendData (targeted photo command to patient). This adds `roomAdmin = true` scoped to the specific room.

> [!IMPORTANT]
> **Thumbnail deferred to post-MVP.** `media_objects` schema supports `Thumbnail` kind but no producer is implemented in M1–M5. Manager gallery uses Original directly. Thumbnail can be added as M6 with a background processor (ImageSharp or patient-side resize-then-upload).

> [!IMPORTANT]
> **Manager DELETE endpoint deferred from M5 MVP.** Only the state machine transition (Ready → DeletePending) is implemented. The retention worker handles actual deletion. This removes synchronous delete complexity and is consistent with the existing retention design.

---

## Open Questions (Resolved)

| Question | Answer |
|---|---|
| LiveKit TrackEgress API method | `StartTrackCompositeEgress` — singular `video_track_id`, no `participant_identity` |
| LiveKit DataChannel API | `livekit-client@2.21.0` has `publishData()` — but **backend uses RoomService.SendData, not client-side broadcast** |
| Consent gate for auto-audio | Keep: audio only starts after `ConsentStatus.Granted`. Audio covers consent-onwards, not retroactive |
| Patient camera track detection | Backend queries LiveKit RoomService (roomAdmin token), selects track `source=CAMERA, type=VIDEO` belonging to patient participant. Client trackSid = optional hint only |

---

## Proposed Changes (Revised)

---

### M1 — Durable Consultation + Media Catalog

---

#### DB Schema Corrections

**Key design principle:**
- `media_assets` = lifecycle / business metadata (who, when, status, egress correlation)
- `media_objects` = physical metadata (storage key, bytes, etag, width, height, duration, mime_type)

**NO physical metadata on `media_assets`.** This avoids the multi-object ambiguity (which width/height for a Snapshot that has Original + Thumbnail?).

```sql
-- NEW TABLES (additive — existing recordings/recording_objects untouched)

CREATE TABLE IF NOT EXISTS consultation_sessions (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_id              UUID NOT NULL,
    clinic_id            TEXT NOT NULL,
    livekit_room_name    TEXT NOT NULL,
    initial_media_mode   TEXT NOT NULL DEFAULT 'Audio',   -- 'Audio' | 'Video'
    -- Durable display snapshot (not joined from in-memory IdentityRegistry)
    caller_id            TEXT NOT NULL,
    caller_display_name  TEXT NOT NULL DEFAULT '',
    staff_id             TEXT NULL,
    staff_display_name   TEXT NULL,
    started_at           TIMESTAMPTZ NULL,
    ended_at             TIMESTAMPTZ NULL,
    status               TEXT NOT NULL DEFAULT 'Active',  -- 'Active' | 'Ended'
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uix_consultation_call
    ON consultation_sessions (call_id);
CREATE INDEX IF NOT EXISTS ix_consultation_clinic
    ON consultation_sessions (clinic_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS media_assets (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id            UUID NOT NULL REFERENCES consultation_sessions(id),
    call_id               UUID NOT NULL,
    clinic_id             TEXT NOT NULL,

    -- Lifecycle
    kind                  TEXT NOT NULL,    -- 'CallAudio' | 'DentalVideoClip' | 'Snapshot'
    status                TEXT NOT NULL,    -- see state machines below
    created_by            TEXT NULL,        -- staff id who triggered (null for auto-audio)

    -- Egress correlation (null for Snapshot)
    egress_id             TEXT NULL,
    source_participant_id TEXT NULL,        -- patient participant identity
    source_track_id       TEXT NULL,        -- patient camera track SID (dental/snapshot)

    -- Timestamps (business timeline for Manager media timeline view)
    requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at            TIMESTAMPTZ NULL,         -- Egress ACTIVE or upload start
    ended_at              TIMESTAMPTZ NULL,          -- Egress COMPLETE or upload done
    captured_at           TIMESTAMPTZ NULL,          -- snapshot moment
    completed_at          TIMESTAMPTZ NULL,          -- Ready transition

    -- Retention
    retention_until       TIMESTAMPTZ NULL,

    -- Optional annotation (not required in workflow)
    label                 TEXT NULL,
    note                  TEXT NULL,

    -- Failure
    error                 TEXT NULL,

    -- Finalize clocks (reuse pattern from recordings)
    finalizing_started_at TIMESTAMPTZ NULL,
    terminal_seen_at      TIMESTAMPTZ NULL,

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Concurrency invariant: at most 1 active CallAudio per call
CREATE UNIQUE INDEX IF NOT EXISTS uix_one_active_audio
    ON media_assets (call_id)
    WHERE kind = 'CallAudio'
      AND status IN ('Requested', 'Recording', 'Finalizing');

-- Concurrency invariant: at most 1 active DentalVideoClip per call
CREATE UNIQUE INDEX IF NOT EXISTS uix_one_active_dental_clip
    ON media_assets (call_id)
    WHERE kind = 'DentalVideoClip'
      AND status IN ('Requested', 'Recording', 'Finalizing');

CREATE INDEX IF NOT EXISTS ix_media_assets_session
    ON media_assets (session_id, requested_at);
CREATE INDEX IF NOT EXISTS ix_media_assets_call
    ON media_assets (call_id, kind, requested_at);
CREATE INDEX IF NOT EXISTS ix_media_assets_egress
    ON media_assets (egress_id) WHERE egress_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_media_assets_stuck
    ON media_assets (status, finalizing_started_at)
    WHERE status IN ('Recording', 'Finalizing', 'Uploading');
CREATE INDEX IF NOT EXISTS ix_media_assets_retention
    ON media_assets (status, retention_until)
    WHERE retention_until IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_objects (
    id              BIGSERIAL PRIMARY KEY,
    media_asset_id  UUID NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
    -- 'Original' | 'Playback' | 'Thumbnail' | 'Archive' | 'Raw'
    kind            TEXT NOT NULL,
    storage_key     TEXT NOT NULL,

    -- Physical metadata ONLY here (not duplicated on media_assets)
    mime_type       TEXT NULL,
    bytes           BIGINT NULL,
    etag            TEXT NULL,
    width           INT NULL,
    height          INT NULL,
    duration_ms     BIGINT NULL,
    bitrate_kbps    INT NULL,
    codec           TEXT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ready_at        TIMESTAMPTZ NULL,
    UNIQUE (media_asset_id, kind)
);
CREATE INDEX IF NOT EXISTS ix_media_objects_key
    ON media_objects (storage_key);
```

**Why partial unique indexes instead of service-layer check:**
- `uix_one_active_audio` — INSERT fails with unique violation if a second CallAudio in `Requested|Recording|Finalizing` exists for same call
- `uix_one_active_dental_clip` — same for DentalVideoClip
- Postgres raises constraint exception → service catches and returns 409
- No race possible regardless of concurrent requests or double-clicks

**sequence_no removed from schema.** Clips ordered by `requested_at` in queries. Display label = `Clip N` computed in API layer from position in ordered list. This removes the transactional sequence generation problem entirely.

---

#### [NEW] `ConsultationCatalog.cs`

Contains all domain types + both implementations:

```csharp
// === Domain records ===

public sealed record ConsultationSession(
    Guid Id, Guid CallId, string ClinicId, string RoomName,
    string InitialMediaMode,
    string CallerId, string CallerDisplayName,
    string? StaffId, string? StaffDisplayName,
    DateTimeOffset? StartedAt, DateTimeOffset? EndedAt,
    string Status, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public sealed record MediaAsset(
    Guid Id, Guid SessionId, Guid CallId, string ClinicId,
    string Kind, string Status,
    string? CreatedBy, string? EgressId,
    string? SourceParticipantId, string? SourceTrackId,
    DateTimeOffset RequestedAt,
    DateTimeOffset? StartedAt, DateTimeOffset? EndedAt,
    DateTimeOffset? CapturedAt, DateTimeOffset? CompletedAt,
    DateTimeOffset? RetentionUntil,
    string? Label, string? Note, string? Error,
    DateTimeOffset? FinalizingStartedAt, DateTimeOffset? TerminalSeenAt,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public sealed record MediaObject(
    long Id, Guid MediaAssetId, string Kind, string StorageKey,
    string? MimeType, long? Bytes, string? Etag,
    int? Width, int? Height, long? DurationMs,
    int? BitrateKbps, string? Codec,
    DateTimeOffset CreatedAt, DateTimeOffset? ReadyAt);

public sealed record MediaAssetInsert(
    Guid SessionId, Guid CallId, string ClinicId,
    string Kind, string? CreatedBy,
    string? SourceParticipantId, string? SourceTrackId,
    DateTimeOffset? RetentionUntil);

// === Status constants ===

public static class MediaAssetStatus
{
    public const string Requested   = "Requested";
    public const string Recording   = "Recording";   // egress-backed
    public const string Finalizing  = "Finalizing";  // egress-backed
    public const string Uploading   = "Uploading";   // snapshot
    public const string Ready       = "Ready";
    public const string Failed      = "Failed";
    public const string DeletePending = "DeletePending";
    public const string Deleted     = "Deleted";

    public static bool IsActive(string s) =>
        s is Requested or Recording or Finalizing or Uploading;
    public static bool IsTerminal(string s) =>
        s is Ready or Failed or Deleted or DeletePending;
    public static bool IsDownloadable(string s) => s == Ready;
}

// === IConsultationCatalog interface ===

public interface IConsultationCatalog
{
    string BackendName { get; }
    Task EnsureSchemaAsync(CancellationToken ct = default);

    // Session
    Task<ConsultationSession> EnsureSessionAsync(
        Guid callId, string clinicId, string roomName,
        string callerId, string callerDisplayName,
        string? staffId, string? staffDisplayName,
        string initialMediaMode, CancellationToken ct = default);
    Task MarkSessionEndedAsync(Guid callId, CancellationToken ct = default);
    Task<ConsultationSession?> GetSessionByCallIdAsync(Guid callId, CancellationToken ct = default);
    Task<IReadOnlyList<ConsultationSession>> ListSessionsByClinicAsync(
        string clinicId, int limit, int offset, CancellationToken ct = default);

    // Asset lifecycle
    Task<Guid> InsertMediaAssetAsync(MediaAssetInsert insert, CancellationToken ct = default);
    Task<bool> TryMarkRecordingAsync(Guid assetId, string egressId, CancellationToken ct = default);
    Task<bool> TryMarkFinalizingAsync(Guid assetId, string egressId, CancellationToken ct = default);
    Task<bool> TryMarkReadyAsync(
        Guid assetId, string egressId, long? durationMs,
        DateTimeOffset endedAt, CancellationToken ct = default);
    Task<bool> TryMarkUploadingAsync(Guid assetId, CancellationToken ct = default);
    Task<bool> TryMarkSnapshotReadyAsync(
        Guid assetId, DateTimeOffset capturedAt, CancellationToken ct = default);
    Task<bool> TryMarkFailedAsync(Guid assetId, string? egressId, string error, CancellationToken ct = default);
    Task<bool> TrySetTerminalSeenAsync(Guid assetId, string egressId, CancellationToken ct = default);
    Task<bool> TryMarkDeletePendingAsync(Guid assetId, CancellationToken ct = default);
    Task MarkDeletedAsync(Guid assetId, CancellationToken ct = default);

    // Object (physical file records)
    Task UpsertMediaObjectAsync(
        Guid assetId, string kind, string storageKey,
        string? mimeType, long? bytes, string? etag,
        int? width, int? height, long? durationMs,
        int? bitrateKbps, string? codec,
        CancellationToken ct = default);
    Task<IReadOnlyList<MediaObject>> GetObjectsByAssetAsync(Guid assetId, CancellationToken ct = default);
    Task<MediaObject?> GetObjectByAssetAndKindAsync(Guid assetId, string kind, CancellationToken ct = default);

    // Queries
    Task<MediaAsset?> GetAssetByIdAsync(Guid assetId, CancellationToken ct = default);
    Task<MediaAsset?> GetAssetByEgressIdAsync(string egressId, CancellationToken ct = default);
    Task<MediaAsset?> GetActiveAudioAssetAsync(Guid callId, CancellationToken ct = default);
    Task<MediaAsset?> GetActiveDentalClipAsync(Guid callId, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListAssetsBySessionAsync(Guid sessionId, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListActiveAssetsByCallAsync(Guid callId, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListStuckAssetsAsync(int limit, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListDueForRetentionAsync(int limit, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListDeletePendingAsync(int limit, CancellationToken ct = default);

    // Session media counts (for list view)
    Task<(int audio, int video, int photo)> GetMediaCountsAsync(
        Guid sessionId, CancellationToken ct = default);
}
```

**PostgresConsultationCatalog key implementation notes:**
- `InsertMediaAssetAsync` wraps INSERT in a try/catch for `PostgresException` with code `23505` (unique_violation) → re-throw as `MediaAssetConflictException`
- Service layer catches `MediaAssetConflictException` → HTTP 409
- `EnsureSessionAsync` uses `INSERT ... ON CONFLICT (call_id) DO UPDATE SET updated_at = now() RETURNING *` — idempotent
- All state transitions use `WHERE status = @expected` to prevent stale transitions

#### [MODIFY] [`Models.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Models.cs)

Add to `CallSession` (old fields unchanged):
```csharp
// NEW: consultation domain — UI cache only, not source of truth after restart
public Guid? ConsultationSessionId { get; set; }
public Guid? ActiveDentalClipAssetId { get; set; }
public string ActiveDentalClipStatus { get; set; } = "Idle";  // "Idle"|"Recording"|"Finalizing"
public string AutoAudioStatus { get; set; } = "Idle";         // "Idle"|"Recording"|"Finalizing"|"Ready"|"Failed"
```

#### [NEW] `ConsultationEndpoints.cs` + `MediaEndpoints.cs`

Split endpoint registration out of `Program.cs`:

```csharp
// ConsultationEndpoints.cs
public static class ConsultationEndpoints
{
    public static IEndpointRouteBuilder MapConsultationEndpoints(
        this IEndpointRouteBuilder app) { ... }
}

// MediaEndpoints.cs
public static class MediaEndpoints
{
    public static IEndpointRouteBuilder MapMediaEndpoints(
        this IEndpointRouteBuilder app) { ... }
}
```

`Program.cs` becomes:
```csharp
app.MapConsultationEndpoints();
app.MapMediaEndpoints();
```

#### [MODIFY] [`RecordingStorage.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingStorage.cs)

Add to `IRecordingStorage`:
```csharp
/// <summary>SigV4 presigned PUT for direct browser upload (short TTL). Null if unsupported.</summary>
string? CreatePresignedPutUrl(string storageKey, TimeSpan ttl);
```

Add new storage key patterns (separate static class `MediaStorageKeys`):
```csharp
public static class MediaStorageKeys
{
    // Audio: .mp3 for browser-playable audio (LiveKit audio-only Egress supports MP3/OGG)
    public static string AudioKey(string clinicId, Guid callId, Guid assetId)
        => $"clinic/{S(clinicId)}/calls/{callId:N}/audio/{assetId:N}.mp3";

    // Dental video: .mp4 (TrackCompositeEgress H264 → MP4)
    public static string VideoClipKey(string clinicId, Guid callId, Guid assetId)
        => $"clinic/{S(clinicId)}/calls/{callId:N}/videos/{assetId:N}.mp4";

    // Snapshot: .jpg Original only (no thumbnail in MVP)
    public static string PhotoOriginalKey(string clinicId, Guid callId, Guid assetId)
        => $"clinic/{S(clinicId)}/calls/{callId:N}/photos/{assetId:N}/original.jpg";

    private static string S(string v) => RecordingStorageKeys.Sanitize(v); // reuse helper
}
```

#### [MODIFY] [`Program.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Program.cs)

- Register `IConsultationCatalog` singleton
- Call `EnsureSchemaAsync()` at startup

---

### M2 — Auto Full-Call Audio

---

#### AudioOnly Egress — Critical Fix

`StartRoomRecordingAsync` currently sends:
```json
{ "room_name": "...", "layout": "grid", "audio_only": true, "file_outputs": [...] }
```

This is wrong for audio-only. LiveKit RoomCompositeEgress in audio-only mode must NOT include `layout` or `custom_base_url`. Required payload:

```json
{
  "room_name": "...",
  "audio_only": true,
  "file_outputs": [
    {
      "file_type": "MP3",
      "filepath": "clinic/.../audio/{assetId}.mp3",
      "s3": { ... }
    }
  ]
}
```

#### [MODIFY] [`LiveKitEgressService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/LiveKitEgressService.cs)

Add dedicated method (do NOT extend `StartRoomRecordingAsync` with more branches):

```csharp
/// <summary>
/// RoomCompositeEgress audio-only. No layout, no video encoder.
/// Output: MP3 (browser-playable, ~96–128 kbps AAC/MP3).
/// Note: LiveKit audio-only composite does NOT accept layout or custom_base_url.
/// </summary>
public async Task<EgressResult> StartRoomAudioRecordingAsync(
    string roomName,
    string fileName,
    string? storageKey = null,
    CancellationToken cancellationToken = default)
{
    await EnsureRoomAsync(roomName, cancellationToken);
    var fileOutput = BuildFileOutput(fileName, storageKey);
    // Override file_type to MP3 for audio-only
    fileOutput["file_type"] = "MP3";
    var request = new Dictionary<string, object?>
    {
        ["room_name"] = roomName,
        ["audio_only"] = true,
        // NO "layout" key — audio-only must not include it
        ["file_outputs"] = new[] { fileOutput }
    };
    return await PostAsync("StartRoomCompositeEgress", request, cancellationToken);
}
```

#### [MODIFY] [`LiveKitTokenService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/LiveKitTokenService.cs)

Add `roomAdmin` grant for RoomService operations (participant query + SendData):

```csharp
/// <summary>
/// Room admin token scoped to ONE room for RoomService operations:
/// ListParticipants (track resolution) and SendData (targeted photo command).
/// Never issued to clients.
/// </summary>
public string CreateRoomAdminToken(string roomName, TimeSpan? ttl = null)
{
    var now = DateTimeOffset.UtcNow;
    var header = new Dictionary<string, object> { ["alg"] = "HS256", ["typ"] = "JWT" };
    var payload = new Dictionary<string, object?>
    {
        ["iss"] = _apiKey,
        ["sub"] = "simlydent-room-admin",
        ["nbf"] = now.ToUnixTimeSeconds(),
        ["exp"] = now.Add(ttl ?? TimeSpan.FromMinutes(2)).ToUnixTimeSeconds(),
        ["jti"] = Guid.NewGuid().ToString("N"),
        ["video"] = new
        {
            roomAdmin = true,   // required for SendData + participant queries
            roomRecord = true,  // retained for Egress operations
            roomCreate = true,
            room = roomName     // scoped to one room
        }
    };
    return Sign(header, payload);
}
```

#### [NEW] `ConsultationAudioService.cs`

```csharp
public sealed class ConsultationAudioService(
    IConsultationCatalog catalog,
    IRecordingStorage storage,
    LiveKitEgressService egress,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    ILogger<ConsultationAudioService> logger)
{
    /// <summary>
    /// Idempotent auto-audio start.
    /// DB unique index prevents duplicate active audio (catches the race the service cannot).
    /// Never throws — audio failure must not fail the call.
    /// </summary>
    public async Task EnsureAutoAudioStartedAsync(CallSession call, CancellationToken ct = default)
    {
        // 1. Policy consent gate
        var policy = policies.Get(call.ClinicId);
        if (policy.RequireConsent && call.ConsentStatus != ConsentStatus.Granted)
            return; // Audio will start when consent arrives

        // 2. Session must exist
        var session = await catalog.GetSessionByCallIdAsync(call.Id, ct);
        if (session is null) return;

        // 3. Idempotency check (fast path before DB insert attempt)
        var existing = await catalog.GetActiveAudioAssetAsync(call.Id, ct);
        if (existing is not null) return;

        var assetId = Guid.NewGuid();
        var storageKey = MediaStorageKeys.AudioKey(call.ClinicId, call.Id, assetId);
        var fileName = $"audio-{call.ClinicId}-{call.Id:N}-{assetId:N}.mp3";

        try
        {
            var retentionUntil = DateTimeOffset.UtcNow.AddDays(policy.RetentionDays);
            assetId = await catalog.InsertMediaAssetAsync(new MediaAssetInsert(
                session.Id, call.Id, call.ClinicId,
                "CallAudio", createdBy: null,
                sourceParticipantId: null, sourceTrackId: null,
                retentionUntil), ct);
        }
        catch (MediaAssetConflictException)
        {
            // Concurrent request already inserted — idempotent
            logger.LogDebug("Auto audio already started for call {CallId}", call.Id);
            return;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Auto audio asset insert failed for call {CallId}", call.Id);
            audit.Append(call.ClinicId, call.Id, null, "system", "System",
                "ConsultationAudioStartFailed", "Failed", ex.Message);
            return; // Never fail call
        }

        // Pre-create media_object placeholder (storage key tracked before Egress starts)
        await catalog.UpsertMediaObjectAsync(assetId, "Original", storageKey,
            mimeType: "audio/mpeg", bytes: null, etag: null,
            width: null, height: null, durationMs: null,
            bitrateKbps: null, codec: null, ct);

        EgressResult result;
        try
        {
            result = await egress.StartRoomAudioRecordingAsync(
                call.RoomName, fileName, storageKey, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Auto audio Egress start failed for call {CallId}", call.Id);
            await catalog.TryMarkFailedAsync(assetId, null, ex.Message, ct);
            lock (call.SyncRoot) { call.AutoAudioStatus = "Failed"; }
            audit.Append(call.ClinicId, call.Id, assetId.ToString(), "system", "System",
                "ConsultationAudioStartFailed", "Failed", ex.Message);
            return; // Never fail call
        }

        await catalog.TryMarkRecordingAsync(assetId, result.EgressId, ct);
        lock (call.SyncRoot)
        {
            call.ConsultationSessionId = session.Id;
            call.AutoAudioStatus = "Recording";
        }
        audit.Append(call.ClinicId, call.Id, assetId.ToString(), "system", "System",
            "ConsultationAudioStarted", "Ok");
    }

    /// <summary>
    /// Bounded stop — mirrors CallEndService pattern.
    /// Transitions to Finalizing, sends short StopEgress control call.
    /// Never awaits COMPLETE or materialize.
    /// </summary>
    public async Task StopAudioAsync(MediaAsset asset, CallSession call, CancellationToken ct = default)
    {
        if (!MediaAssetStatus.IsActive(asset.Status)) return;
        if (string.IsNullOrWhiteSpace(asset.EgressId)) return;

        try { await catalog.TryMarkFinalizingAsync(asset.Id, asset.EgressId, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Audio Finalizing mark failed"); }

        lock (call.SyncRoot) { call.AutoAudioStatus = "Finalizing"; }

        try { await egress.RequestStopAsync(asset.EgressId, ct); }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "StopEgress control failed for audio {EgressId} (staying Finalizing)", asset.EgressId);
        }

        audit.Append(call.ClinicId, call.Id, asset.Id.ToString(), "system", "System",
            "ConsultationAudioStopRequested", "Ok");
    }
}
```

#### [NEW] `ConsultationMediaLifecycleService.cs`

**Replaces** ad-hoc audio stop in CallEndService. Stops ALL active media when call ends:

```csharp
public sealed class ConsultationMediaLifecycleService(
    IConsultationCatalog catalog,
    ConsultationAudioService audioService,
    DentalClipService clipService,
    ILogger<ConsultationMediaLifecycleService> logger)
{
    /// <summary>
    /// On call end: stop audio + any active dental clip.
    /// Bounded await; never blocks call End transition.
    /// </summary>
    public async Task StopAllActiveMediaAsync(CallSession call, CancellationToken ct = default)
    {
        var active = await catalog.ListActiveAssetsByCallAsync(call.Id, ct);
        foreach (var asset in active)
        {
            switch (asset.Kind)
            {
                case "CallAudio":
                    await audioService.StopAudioAsync(asset, call, ct);
                    break;
                case "DentalVideoClip":
                    await clipService.StopClipCoreAsync(asset, call, ct);
                    break;
                // Snapshot Uploading: stay Uploading; reconcile/retry handles it
            }
        }

        try { await catalog.MarkSessionEndedAsync(call.Id, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "MarkSessionEnded failed for {CallId}", call.Id); }
    }
}
```

#### [MODIFY] [`CallEndService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/CallEndService.cs)

Replace single-recording stop logic with `StopAllActiveMediaAsync`:

```csharp
// After dispatcher.TryEndAsync succeeds:
// 1. OLD: stop single egress (keep for legacy recordings table compatibility)
// 2. NEW: stop all new media assets
try
{
    await _mediaLifecycle.StopAllActiveMediaAsync(call, cancellationToken);
}
catch (Exception ex)
{
    _logger.LogWarning(ex, "StopAllActiveMedia failed on call end {CallId}", call.Id);
    // Never fail — call is already Ended
}
```

The old single-recording stop path stays for backward compat with `recordings` table rows.

#### [MODIFY] [`RecordingFinalizeService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingFinalizeService.cs)

Add new result type and method:

```csharp
/// <summary>
/// Tri-state: Found distinguishes "unknown egress" from "no change needed".
/// Prevents incorrect fallback to old recording catalog when webhook hits a terminal asset.
/// </summary>
public sealed record FinalizeMediaResult(bool Found, bool Changed, string? NewStatus, string? Detail);

public async Task<FinalizeMediaResult> ApplyMediaEgressStatusAsync(
    string egressId,
    string? egressStatus,
    string? error,
    string? errorCode,
    CancellationToken ct = default)
{
    var asset = await _consultationCatalog.GetAssetByEgressIdAsync(egressId, ct);
    if (asset is null)
        return new FinalizeMediaResult(Found: false, Changed: false, null, "unknown_egress");

    if (MediaAssetStatus.IsTerminal(asset.Status))
        return new FinalizeMediaResult(Found: true, Changed: false, asset.Status, "already_terminal");

    // Apply same logic as existing ApplyEgressStatusAsync but against media_assets
    // ... (COMPLETE → HeadObject → Ready; FAILED → Failed)
    // Updates media_objects with physical metadata (bytes, duration) from Egress result
}
```

**Webhook handler** (in `MediaEndpoints.cs`):
```csharp
// 1. Try new media catalog
var mediaResult = await finalize.ApplyMediaEgressStatusAsync(egressId, ...);
if (!mediaResult.Found)
{
    // 2. Only fallback if NOT found in media_assets
    // If Found=true but Changed=false (terminal/idempotent), do NOT fall through
    var oldResult = await finalize.ApplyEgressStatusAsync(egressId, ...);
}
```

---

### M3 — Manual Dental Video Clips (Revised)

---

#### TrackCompositeEgress — Corrected Contract

Based on LiveKit API docs, `StartTrackCompositeEgress` payload:

```json
{
  "room_name": "clinic:clinic-a:call:...",
  "video_track_id": "TR_xxxxxxxx",
  "file_outputs": [
    {
      "file_type": "MP4",
      "filepath": "clinic/.../videos/{assetId}.mp4",
      "s3": { ... }
    }
  ],
  "advanced": {
    "videoCodec": "H264_MAIN",
    "videoBitrate": 4000,
    "framerate": 30
  }
}
```

**Key differences from v1:**
- `video_track_id` (singular string) — NOT `video_track_ids` (array)
- NO `participant_identity` field in TrackCompositeEgress request
- NO `audio_track_ids` (video-only for dental, audio captured by separate CallAudio Egress)

> [!NOTE]
> Post-MVP benchmark option: `StartTrackEgress` (pure pass-through, no transcode). Reduces Egress CPU significantly. Output codec depends on source (H264→MP4, VP8→WebM). File not guaranteed playable in all browsers without re-encode. Revisit after M6 dental quality benchmark confirms source codec.

#### [MODIFY] [`LiveKitEgressService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/LiveKitEgressService.cs)

Add:
```csharp
public enum DentalQualityProfile
{
    /// <summary>Benchmark target — only use when source track confirmed >= 1080p.</summary>
    HD_1080p_30,
    /// <summary>Safe fallback for most mobile cameras.</summary>
    HD_720p_30
}

/// <summary>
/// TrackCompositeEgress — patient camera video track ONLY (no audio).
/// Uses video_track_id (singular), no participant_identity.
/// Quality ceiling is source camera publish quality — Egress cannot create detail not in source.
/// </summary>
public async Task<EgressResult> StartTrackCompositeRecordingAsync(
    string roomName,
    string videoTrackId,       // patient camera SID — resolved by server from RoomService
    string fileName,
    string? storageKey = null,
    DentalQualityProfile profile = DentalQualityProfile.HD_720p_30,
    CancellationToken cancellationToken = default)
{
    var (width, height, bitrateKbps) = profile switch
    {
        DentalQualityProfile.HD_1080p_30 => (
            ParsePositiveInt(_configuration["DENTAL_WIDTH_1080"], 1920),
            ParsePositiveInt(_configuration["DENTAL_HEIGHT_1080"], 1080),
            ParsePositiveInt(_configuration["DENTAL_BITRATE_1080_KBPS"], 4000)),
        _ => (
            ParsePositiveInt(_configuration["DENTAL_WIDTH_720"], 1280),
            ParsePositiveInt(_configuration["DENTAL_HEIGHT_720"], 720),
            ParsePositiveInt(_configuration["DENTAL_BITRATE_720_KBPS"], 2500))
    };

    var fileOutput = BuildFileOutput(fileName, storageKey);
    var request = new Dictionary<string, object?>
    {
        ["room_name"] = roomName,
        ["video_track_id"] = videoTrackId,   // singular, NOT array
        // NO participant_identity
        ["file_outputs"] = new[] { fileOutput },
        ["advanced"] = new Dictionary<string, object?>
        {
            ["width"] = width,
            ["height"] = height,
            ["framerate"] = 30,
            ["videoCodec"] = "H264_MAIN",
            ["videoBitrate"] = bitrateKbps
        }
    };
    return await PostAsync("StartTrackCompositeEgress", request, cancellationToken);
}
```

#### [NEW] `LiveKitRoomService.cs`

New helper for RoomService API calls (ListParticipants, SendData). Uses `CreateRoomAdminToken`:

```csharp
public sealed class LiveKitRoomService(
    HttpClient httpClient,
    IConfiguration configuration,
    LiveKitTokenService tokens)
{
    /// <summary>
    /// Find patient participant's camera track SID.
    /// Selects track: source=CAMERA, type=VIDEO, published, belongs to patient participant.
    /// Returns null if patient not found or camera not published.
    /// </summary>
    public async Task<(string participantIdentity, string trackSid)?> FindPatientCameraTrackAsync(
        string roomName,
        string patientParticipantIdentity,
        CancellationToken ct = default);

    /// <summary>
    /// Send data to specific participant(s) via RoomService (server-side, targeted).
    /// Requires roomAdmin grant. Does NOT require server to join the room.
    /// </summary>
    public async Task SendDataToParticipantAsync(
        string roomName,
        string destinationIdentity,
        byte[] data,
        bool reliable = true,
        CancellationToken ct = default);
}
```

**`FindPatientCameraTrackAsync` implementation:**
- POST `/twirp/livekit.RoomService/GetParticipant` with `{ room: roomName, identity: patientIdentity }`
- From response, find track where `source = SOURCE_CAMERA`, `type = VIDEO`, `muted = false`
- Return `(participantIdentity, track.sid)` or null

**`SendDataToParticipantAsync` implementation:**
- POST `/twirp/livekit.RoomService/SendData` with `{ room, data, reliable, destination_identities: [identity] }`

#### [NEW] `DentalClipService.cs`

```csharp
public sealed class DentalClipService(
    IConsultationCatalog catalog,
    IRecordingStorage storage,
    LiveKitEgressService egress,
    LiveKitRoomService roomService,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    ILogger<DentalClipService> logger)
{
    public async Task<(Guid AssetId, string Status)> StartClipAsync(
        CallSession call,
        TestIdentity staff,
        string patientParticipantIdentity,   // from Staff client (hint)
        string? patientVideoTrackSidHint,    // optional client hint
        CancellationToken ct = default);

    /// <summary>
    /// Core stop logic — called by StopClipAsync (staff request) and
    /// ConsultationMediaLifecycleService (call end).
    /// </summary>
    public async Task StopClipCoreAsync(
        MediaAsset asset, CallSession call, CancellationToken ct = default);

    public async Task<bool> StopClipAsync(
        CallSession call, Guid assetId, CancellationToken ct = default);
}
```

**`StartClipAsync` flow:**
1. Validate: `call.Status == Accepted`
2. Policy consent gate
3. **Server resolves track** via `roomService.FindPatientCameraTrackAsync(roomName, patientIdentity)`
   - Client trackSid hint is verified (must match resolved SID or be ignored)
   - If track not found → 409 "Patient camera must be enabled before recording"
4. Check active dental clip: `catalog.GetActiveDentalClipAsync(call.Id)` — if active → 409
   - Note: DB partial unique index is the final guard; service check is a fast UX path
5. `assetId = await catalog.InsertMediaAssetAsync(...)` — catches `MediaAssetConflictException` → 409
6. Pre-create `media_object` row with storageKey
7. `egress.StartTrackCompositeRecordingAsync(roomName, resolvedTrackSid, ...)`
8. `catalog.TryMarkRecordingAsync(assetId, egressId)`
9. Lock and update `call.ActiveDentalClipAssetId`, `ActiveDentalClipStatus = "Recording"`
10. Audit: `DentalClipStarted` with `sourceTrackId`, `resolvedDimensions`
11. On Egress failure: `TryMarkFailedAsync`; clear `ActiveDentalClipAssetId`; never fail call

**`StopClipCoreAsync` flow (shared by staff request + call end):**
1. Validate asset is active
2. `catalog.TryMarkFinalizingAsync(asset.Id, asset.EgressId)`
3. Lock: `call.ActiveDentalClipStatus = "Finalizing"`
4. `egress.RequestStopAsync(asset.EgressId)` — bounded timeout
5. Audit: `DentalClipStopRequested`

**Source camera quality tracking:**
Staff client must send actual `MediaStreamTrack.getSettings()` at start:
```json
{
  "patientParticipantIdentity": "clinic-a:VA",
  "patientVideoTrackSidHint": "TR_...",
  "actualWidth": 1280,
  "actualHeight": 720,
  "actualFrameRate": 30
}
```

Server stores this in `media_objects` as the `width/height/bitrateKbps` baseline. Egress output quality cannot exceed source.

---

### M4 — Snapshot (Revised)

---

#### Command Flow — Corrected (Backend Sends, Not Staff Client)

```
Staff Client
  │ POST /api/calls/{callId}/photos/request
  ▼
ASP.NET (SnapshotService.RequestCaptureAsync)
  │ 1. Authorize: staff + same clinic + call active
  │ 2. assetId = Guid.NewGuid()
  │ 3. Build server-owned storageKey (never from client)
  │ 4. InsertMediaAssetAsync (kind=Snapshot, source_participant_id = patient identity)
  │ 5. UpsertMediaObjectAsync placeholder (Original key)
  │ 6. CreatePresignedPutUrl(originalKey, ttl=5min)
  │ 7. TryMarkUploadingAsync(assetId)
  │ 8. roomService.SendDataToParticipantAsync(
  │       roomName,
  │       destination = patient identity,     ← TARGETED, not broadcast
  │       data = { type:"capture_photo", assetId, uploadUrl }
  │    )
  │ 9. Return { assetId } to Staff (Staff does NOT receive uploadUrl)
  ▼
Patient Browser (RoomEvent.DataReceived)
  │ 1. Parse message
  │ 2. Capture: ImageCapture.takePhoto() if supported, else canvas fallback
  │ 3. Store actual width/height from capture result / track.getSettings()
  │ 4. PUT uploadUrl with blob (Content-Type: image/jpeg)
  │ 5. POST /api/media/{assetId}/upload-complete
  │       { actualWidth, actualHeight, bytes }
  ▼
ASP.NET (SnapshotService.ConfirmUploadAsync)
  │ 1. Load asset — validate clinic ownership (cross-clinic → 404)
  │ 2. Validate: asset.SourceParticipantId == caller identity  ← patient bound
  │ 3. Validate: status == Uploading, kind == Snapshot
  │ 4. storage.ExistsAsync(originalKey) — HEAD
  │ 5. If not exists → return false (client retries, max N times)
  │ 6. Validate size > 0, MIME type (HEAD response Content-Type)
  │ 7. TryMarkSnapshotReadyAsync(assetId, capturedAt: now)
  │ 8. UpsertMediaObjectAsync(assetId, "Original", storageKey,
  │       mimeType: "image/jpeg", bytes, etag,
  │       width: actualWidth, height: actualHeight, ...)
  │ 9. Audit: SnapshotReady
  ▼
Staff Client
  │ Polls GET /api/calls/{callId}/media-state or receives SignalR event
  │ Photo appears as thumbnail in active call UI
```

**Staff does NOT receive `uploadUrl`** — Staff only gets `{ assetId }` confirming the request was issued. Upload URL is sent directly to patient via backend `SendData`.

#### [NEW] `SnapshotService.cs`

```csharp
public sealed class SnapshotService(
    IConsultationCatalog catalog,
    IRecordingStorage storage,
    LiveKitRoomService roomService,
    RecordingAuditService audit,
    ILogger<SnapshotService> logger)
{
    /// <summary>
    /// Staff requests capture. Backend sends targeted command to patient.
    /// Returns assetId only — uploadUrl is NOT returned to Staff.
    /// </summary>
    public async Task<Guid> RequestCaptureAsync(
        CallSession call,
        TestIdentity staff,
        string patientParticipantIdentity,
        CancellationToken ct = default);

    /// <summary>
    /// Patient confirms upload. Validates caller is the bound patient.
    /// HEAD-checks existence, validates MIME + size, then marks Ready.
    /// </summary>
    public async Task<bool> ConfirmUploadAsync(
        Guid assetId,
        string callerParticipantIdentity,  // must match asset.SourceParticipantId
        int? actualWidth,
        int? actualHeight,
        CancellationToken ct = default);
}
```

**Auth binding in `ConfirmUploadAsync`:**
```csharp
// Validate the caller is the patient who was assigned the capture
if (!string.Equals(asset.SourceParticipantId, callerParticipantIdentity,
        StringComparison.OrdinalIgnoreCase))
    return false; // or throw 403 — caller cannot confirm another participant's upload
```

**Object Storage CORS:**

Required MinIO/S3 bucket CORS (ops step — document in README + `.env.vps.example`):
```xml
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://app.DOMAIN</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <MaxAgeSeconds>300</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

Caddy (if in front of MinIO) must pass-through PUT requests and not strip CORS headers.

#### [MODIFY] [`RecordingStorage.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingStorage.cs)

`CreatePresignedPutUrl` implementation (SigV4 presigned PUT):
- Same signature flow as existing `CreatePresignedGetUrl`
- Method = `PUT`
- Max TTL: 5 minutes (300s)
- Key is server-owned, random — client cannot guess other asset keys

#### Frontend — Patient local capture (revised)

```javascript
// Patient browser — in Room event handler
room.on(RoomEvent.DataReceived, async (data, participant, kind) => {
  let msg
  try { msg = JSON.parse(new TextDecoder().decode(data)) }
  catch { return }

  if (msg.type !== 'capture_photo') return

  // Capture from local camera track (NOT from DOM element)
  const localVideoTrack = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack
  if (!localVideoTrack?.mediaStreamTrack) {
    console.warn('No local camera track for photo capture')
    return
  }

  const settings = localVideoTrack.mediaStreamTrack.getSettings()
  let blob, actualWidth, actualHeight

  // Prefer ImageCapture API (direct from device, highest quality)
  if (typeof ImageCapture !== 'undefined') {
    try {
      const capture = new ImageCapture(localVideoTrack.mediaStreamTrack)
      const bitmap = await capture.takePhoto()  // or grabFrame() for bitmap
      blob = bitmap instanceof Blob ? bitmap : await new Response(bitmap).blob()
      actualWidth = settings.width
      actualHeight = settings.height
    } catch {
      // Fall through to canvas
    }
  }

  // Canvas fallback
  if (!blob) {
    const canvas = document.createElement('canvas')
    const video = localVideoTrack.mediaStreamTrack
    const settings2 = video.getSettings()
    canvas.width = settings2.width || 1280
    canvas.height = settings2.height || 720
    actualWidth = canvas.width
    actualHeight = canvas.height
    // Draw from video element attached to local track
    const videoEl = document.createElement('video')
    videoEl.srcObject = new MediaStream([video])
    await videoEl.play()
    canvas.getContext('2d').drawImage(videoEl, 0, 0)
    blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95))
  }

  // Direct PUT to Object Storage (presigned URL from server, no S3 credentials)
  await fetch(msg.uploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': 'image/jpeg' }
  })

  // Notify backend of completion
  await apiPost(`/api/media/${msg.assetId}/upload-complete`, {
    actualWidth, actualHeight, bytes: blob.size
  })
})
```

#### New endpoints in `MediaEndpoints.cs`

```
POST /api/calls/{callId}/photos/request         → { assetId } (Staff only)
POST /api/media/{assetId}/upload-complete       → 200 (Patient embed auth)
```

---

### M5 — Manager Consultation Media Modal (Revised)

---

#### Durable Historical Identity

`consultation_sessions` includes `caller_display_name` and `staff_display_name` snapshotted at session creation — no join to in-memory `IdentityRegistry` needed. Manager can view historical consultations after API restart.

#### DELETE as State Machine Only

`DELETE /api/media/{assetId}` in M5 MVP:
- Manager only, same clinic
- Validates `status = Ready` (cannot delete active/pending)
- Transitions `Ready → DeletePending` only
- Returns `{ status: "DeletePending" }`
- Retention worker handles actual file deletion → `Deleted`
- Audit: `MediaDeleteRequested`

No synchronous object deletion from this endpoint.

#### Legacy Recording Compatibility

Manager UI has two sections:

```
CONSULTATIONS (new — M1+)
[consultation list grouped by session]

LEGACY RECORDINGS (old recordings table)
[previous flat recording list, labeled "Pre-{date}"]
```

Old `GET /api/recordings` endpoint kept for one release cycle. After all legacy recordings age out of retention, this section can be removed.

#### [`ConsultationModels.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/ConsultationModels.cs)

```csharp
public sealed record ConsultationListItem(
    Guid SessionId, Guid CallId, string ClinicId,
    string PatientId, string PatientDisplayName,
    string? StaffId, string? StaffDisplayName,
    DateTimeOffset? StartedAt, DateTimeOffset? EndedAt,
    int DurationSeconds,
    int AudioCount, int VideoCount, int PhotoCount,
    string Status);

public sealed record ConsultationDetailView(
    Guid SessionId, Guid CallId,
    string PatientDisplayName, string? StaffDisplayName,
    DateTimeOffset? StartedAt, DateTimeOffset? EndedAt,
    MediaAssetDetailView? Audio,
    IReadOnlyList<MediaAssetDetailView> VideoClips,  // ordered by requested_at
    IReadOnlyList<MediaAssetDetailView> Photos);

public sealed record MediaAssetDetailView(
    Guid AssetId, string Kind, string Status,
    int DisplayIndex,    // 1-based, computed from position in ordered list
    DateTimeOffset? StartedAt, DateTimeOffset? EndedAt, DateTimeOffset? CapturedAt,
    // Physical metadata projected from media_objects (kind=Original or Playback)
    long? DurationMs, long? Bytes, int? Width, int? Height, string? MimeType,
    string? Label, string? Note, string? Error,
    bool CanDownload, bool CanMarkDelete);
```

#### New Manager endpoints in `ConsultationEndpoints.cs`

```
GET    /api/consultations                     → paginated ConsultationListItem[]
GET    /api/consultations/{sessionId}         → ConsultationDetailView
GET    /api/media/{assetId}/download-url      → { url, expiresAt, mode }
DELETE /api/media/{assetId}                   → { status: "DeletePending" } (M5 MVP)
```

**`download-url` object selection:**

| Asset Kind | Object Kind served |
|---|---|
| CallAudio | Original (.mp3) |
| DentalVideoClip | Playback or Original (.mp4) |
| Snapshot (download) | Original (.jpg) |
| Snapshot (gallery) | Original (.jpg) — Thumbnail deferred |

---

## State Machines

### CallAudio / DentalVideoClip (Egress-backed)

```
Requested ──► Recording ──► Finalizing ──► Ready ──► DeletePending ──► Deleted
    │              │              │
    └─ Failed      └─ Failed      └─ Failed (timeout)
```

- `Ready` only after `HeadObject` confirms physical file
- `ReadyAt` set on `media_objects` when asset Ready

### Snapshot

```
Requested ──► Uploading ──► Ready ──► DeletePending ──► Deleted
    │              │
    └─ Failed      └─ Failed (validation or timeout)
```

- `Ready` only after HEAD + MIME + size validation passes
- Patient sends up to 3 retries on `/upload-complete`; after that asset stays Uploading for reconcile

---

## Authorization Matrix

| Action | Staff (own call) | Manager (same clinic) | Patient (own session) |
|---|---|---|---|
| Start audio (auto) | System | ❌ | ❌ |
| Start dental clip | ✅ | ❌ | ❌ |
| Stop dental clip | ✅ | ❌ | ❌ |
| Request photo | ✅ | ❌ | ❌ |
| Execute photo upload (PUT) | ❌ | ❌ | ✅ own session |
| Confirm upload-complete | ❌ | ❌ | ✅ bound by source_participant_id |
| List consultations | ❌ | ✅ | ❌ |
| View detail | ❌ | ✅ | ❌ |
| Download media | ❌ | ✅ | ❌ |
| Mark delete (→ DeletePending) | ❌ | ✅ | ❌ |
| Cross-clinic access | 404 | 404 | 404 |

---

## Object Storage Keys

```
clinic/{clinicId}/calls/{callId}/audio/{assetId}.mp3        ← audio/mpeg
clinic/{clinicId}/calls/{callId}/videos/{assetId}.mp4       ← video/mp4
clinic/{clinicId}/calls/{callId}/photos/{assetId}/original.jpg  ← image/jpeg
```

No thumbnail in MVP. Key structure supports future thumbnail at `.../photos/{assetId}/thumbnail.jpg`.

---

## New Files

| File | Purpose |
|---|---|
| `ConsultationCatalog.cs` | `consultation_sessions`, `media_assets`, `media_objects` + `IConsultationCatalog` + Memory + Postgres |
| `ConsultationModels.cs` | DTOs for Manager API |
| `ConsultationAudioService.cs` | Auto full-session audio |
| `ConsultationMediaLifecycleService.cs` | Stop ALL active media on call end |
| `DentalClipService.cs` | Staff-triggered dental clips via TrackCompositeEgress |
| `SnapshotService.cs` | Photo capture + backend SendData + patient upload confirm |
| `LiveKitRoomService.cs` | RoomService helpers (ListParticipants, SendData) |
| `ConsultationEndpoints.cs` | Manager consultation API endpoints |
| `MediaEndpoints.cs` | Dental clip, snapshot, download, upload-complete endpoints |

## Modified Files

| File | Change |
|---|---|
| [`Models.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Models.cs) | Add 4 new `CallSession` fields |
| [`LiveKitEgressService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/LiveKitEgressService.cs) | Add `StartRoomAudioRecordingAsync`, `StartTrackCompositeRecordingAsync`, `DentalQualityProfile` |
| [`LiveKitTokenService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/LiveKitTokenService.cs) | Add `CreateRoomAdminToken(roomName)` |
| [`RecordingStorage.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingStorage.cs) | Add `CreatePresignedPutUrl` + `MediaStorageKeys` |
| [`RecordingFinalizeService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingFinalizeService.cs) | Add `FinalizeMediaResult` + `ApplyMediaEgressStatusAsync` |
| [`RecordingReconcileService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingReconcileService.cs) | Add parallel loop for `media_assets` |
| [`RecordingRetentionService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/RecordingRetentionService.cs) | Add retention for `media_assets` + `media_objects` |
| [`CallEndService.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/CallEndService.cs) | Inject + call `ConsultationMediaLifecycleService` |
| [`Program.cs`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/backend/Program.cs) | DI registration + `app.MapConsultationEndpoints()` + `app.MapMediaEndpoints()` |
| [`frontend/src/main.js`](file:///f:/SimlyDent/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/frontend/src/main.js) | Staff call controls, Patient DataReceived handler, Manager consultation modal |

---

## Required Test Cases (Revised + Expanded)

### Concurrency / Race Conditions

| Test Case | Expected |
|---|---|
| Double-click auto audio trigger (2 concurrent POST) | 1 active CallAudio; DB unique index rejects second INSERT with 409 |
| 2 concurrent `/video-clips/start` | One 200, one 409 (DB constraint catches race) |
| Staff starts dental clip while another request inflight | Second request gets 409 |

### Idempotency / Restart

| Test Case | Expected |
|---|---|
| Duplicate `egress_ended` webhook | `FinalizeMediaResult.Found=true, Changed=false` — no fallback to old catalog |
| API restart while audio Recording | `reconcile` queries LiveKit, finds ACTIVE → no timeout kill; continues Recording |
| API restart while clip Finalizing | `reconcile` queries LiveKit, finds COMPLETE → HeadObject → Ready |
| API restart while snapshot Uploading | Reconcile retries confirm; eventually Ready or Failed |
| EnsureAutoAudioStarted called twice in quick succession | Second call: fast path `GetActiveAudioAssetAsync` finds existing → no-op |

### Call End Edge Cases

| Test Case | Expected |
|---|---|
| End call while dental clip Recording | `StopAllActiveMediaAsync` → clip Finalizing + audio Finalizing |
| End call while snapshot Uploading | Upload continues; session marked Ended; snapshot can still complete |
| End call with no consent (audio not started) | Session created, no audio asset, call Ended cleanly |
| Camera OFF while clip Recording | Staff must Stop clip first; if camera track disappears, Egress emits FAILED → reconcile marks Failed |

### Snapshot Security

| Test Case | Expected |
|---|---|
| Client sends another patient's trackSid | Server ignores hint; resolves own track via RoomService |
| Snapshot command sent to wrong patient | `SendData destination=patient_identity` — only patient B receives if assetId bound to B |
| Upload-complete from unrelated Staff | 404 (asset.SourceParticipantId ≠ caller) |
| Upload-complete from Patient A for Patient B's asset | 404 (source_participant_id check) |
| PUT after presigned URL expires | Object Storage returns 403; upload fails |
| Upload with wrong MIME (video/mp4 instead of image/jpeg) | HEAD content-type validation → Failed |
| Upload oversized (> limit MB) | Size validation → Failed; trigger storage delete |
| Upload zero bytes | size > 0 check → Failed |

### Authorization

| Test Case | Expected |
|---|---|
| Manager B reads Clinic A consultation | 404 |
| Staff reads /api/consultations (Manager-only) | 403 |
| Patient calls /api/calls/{id}/video-clips/start | 403 |
| Manager cannot start dental clip | 403 (CanStartStop = false for Manager) |

### Legacy Compatibility

| Test Case | Expected |
|---|---|
| Old `recordings` row after M5 | Visible in "Legacy Recordings" section of Manager UI |
| `GET /api/calls/{id}/recording/download-url` (old endpoint) | Still works (kept 1 cycle with deprecation note) |
| Feature flag `FEATURE_MEDIA_ASSETS=false` | New endpoints return 404; old recording path unaffected |

---

## Implementation Sequence (PR order)

```
PR M1: ConsultationCatalog + DB schema + IConsultationCatalog
       + EnsureSession on Accept + MediaStorageKeys + DI registration
       + ConsultationEndpoints.cs / MediaEndpoints.cs skeletons
       Acceptance: psql shows 3 new tables; EnsureSession creates row on Accept

PR M2: LiveKitTokenService.CreateRoomAdminToken
       + LiveKitEgressService.StartRoomAudioRecordingAsync (no layout, MP3)
       + ConsultationAudioService + ConsultationMediaLifecycleService
       + CallEndService wired
       + RecordingFinalizeService.ApplyMediaEgressStatusAsync (dual-catalog)
       + RecordingReconcileService parallel loop
       Acceptance: Accept → CallAudio Recording; End → Finalizing → Ready

PR M3: LiveKitRoomService (FindPatientCameraTrack + SendData)
       + LiveKitEgressService.StartTrackCompositeRecordingAsync
       + DentalClipService
       + POST /video-clips/start + /stop + GET /video-clips
       Acceptance: 2 separate clips in same call both reach Ready

PR M4: IRecordingStorage.CreatePresignedPutUrl + S3 impl
       + SnapshotService (backend-targeted SendData)
       + Patient DataReceived handler (ImageCapture + canvas fallback)
       + POST /photos/request + POST /upload-complete
       Acceptance: Staff requests → patient captures → Ready; Staff never sees uploadUrl

PR M5: ConsultationModels + Manager endpoints (list + detail + download + delete→pending)
       + Manager UI consultation modal + legacy compatibility section
       + Photo gallery (Original only, no thumbnail)
       Acceptance: Manager sees 1 audio + 2 clips + 2 photos; lightbox zoom; legacy section

Post-M5: Dental quality benchmark (M6)
         TrackEgress pass-through evaluation
         Thumbnail background processor (M7)
```

---

## Rollback

- All DB changes `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` — fully additive
- Feature flag `FEATURE_MEDIA_ASSETS` (`appsettings.json` or env) gates all new endpoints
- Old `recordings` path continues working regardless of flag
- If M3 TrackCompositeEgress fails: RoomCompositeEgress video-only as temporary fallback (same infra, different quality)
- Presigned PUT added to S3 only; local backend returns null (snapshot shows "Upload not supported in local mode")
