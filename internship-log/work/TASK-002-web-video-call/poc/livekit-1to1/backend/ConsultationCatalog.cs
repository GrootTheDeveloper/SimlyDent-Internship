using System.Collections.Concurrent;
using Npgsql;

namespace LiveKitPoc.Api;

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
    Guid Id,
    Guid SessionId, Guid CallId, string ClinicId,
    string Kind, string? CreatedBy,
    string? SourceParticipantId, string? SourceTrackId,
    DateTimeOffset? RetentionUntil);

public static class MediaAssetKinds
{
    public const string CallAudio = "CallAudio";
    public const string DentalVideoClip = "DentalVideoClip";
    public const string Snapshot = "Snapshot";
}

public static class MediaObjectKinds
{
    public const string Original = "Original";
    public const string Playback = "Playback";
    public const string Thumbnail = "Thumbnail";
}

public static class MediaAssetStatus
{
    public const string Requested = "Requested";
    public const string Recording = "Recording";
    public const string Finalizing = "Finalizing";
    public const string Uploading = "Uploading";
    public const string Ready = "Ready";
    public const string Failed = "Failed";
    public const string DeletePending = "DeletePending";
    public const string Deleted = "Deleted";

    public static bool IsActive(string s) =>
        s is Requested or Recording or Finalizing or Uploading;

    public static bool IsTerminal(string s) =>
        s is Ready or Failed or Deleted or DeletePending;

    public static bool IsDownloadable(string s) => s == Ready;
}

public sealed class MediaAssetConflictException : Exception
{
    public MediaAssetConflictException(string message) : base(message) { }
}

// === IConsultationCatalog ===

public interface IConsultationCatalog
{
    string BackendName { get; }
    Task EnsureSchemaAsync(CancellationToken ct = default);

    Task<ConsultationSession> EnsureSessionAsync(
        Guid callId, string clinicId, string roomName,
        string callerId, string callerDisplayName,
        string? staffId, string? staffDisplayName,
        string initialMediaMode, CancellationToken ct = default);

    Task MarkSessionEndedAsync(Guid callId, CancellationToken ct = default);
    Task<ConsultationSession?> GetSessionByCallIdAsync(Guid callId, CancellationToken ct = default);
    Task<ConsultationSession?> GetSessionByIdAsync(Guid sessionId, CancellationToken ct = default);
    Task<IReadOnlyList<ConsultationSession>> ListSessionsByClinicAsync(
        string clinicId, int limit, int offset, CancellationToken ct = default);

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

    Task UpsertMediaObjectAsync(
        Guid assetId, string kind, string storageKey,
        string? mimeType, long? bytes, string? etag,
        int? width, int? height, long? durationMs,
        int? bitrateKbps, string? codec,
        CancellationToken ct = default);

    Task MarkMediaObjectReadyAsync(
        Guid assetId, string kind, long? bytes, string? etag, long? durationMs,
        CancellationToken ct = default);

    Task<IReadOnlyList<MediaObject>> GetObjectsByAssetAsync(Guid assetId, CancellationToken ct = default);
    Task<MediaObject?> GetObjectByAssetAndKindAsync(Guid assetId, string kind, CancellationToken ct = default);

    Task<MediaAsset?> GetAssetByIdAsync(Guid assetId, CancellationToken ct = default);
    Task<MediaAsset?> GetAssetByEgressIdAsync(string egressId, CancellationToken ct = default);
    Task<MediaAsset?> GetActiveAudioAssetAsync(Guid callId, CancellationToken ct = default);
    Task<MediaAsset?> GetActiveDentalClipAsync(Guid callId, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListAssetsBySessionAsync(Guid sessionId, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListActiveAssetsByCallAsync(Guid callId, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListStuckAssetsAsync(int limit, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListDueForRetentionAsync(int limit, CancellationToken ct = default);
    Task<IReadOnlyList<MediaAsset>> ListDeletePendingAsync(int limit, CancellationToken ct = default);

    Task<(int audio, int video, int photo)> GetMediaCountsAsync(Guid sessionId, CancellationToken ct = default);
}

// === Memory implementation ===

public sealed class MemoryConsultationCatalog : IConsultationCatalog
{
    private readonly ConcurrentDictionary<Guid, ConsultationSession> _sessions = new();
    private readonly ConcurrentDictionary<Guid, MediaAsset> _assets = new();
    private readonly ConcurrentDictionary<long, MediaObject> _objects = new();
    private readonly ConcurrentDictionary<Guid, Guid> _sessionByCall = new();
    private long _objectSeq;
    private readonly object _gate = new();

    public string BackendName => "memory";

    public Task EnsureSchemaAsync(CancellationToken ct = default) => Task.CompletedTask;

    private readonly Dictionary<string, int> _guestSeq = new(StringComparer.OrdinalIgnoreCase);

    public Task<ConsultationSession> EnsureSessionAsync(
        Guid callId, string clinicId, string roomName,
        string callerId, string callerDisplayName,
        string? staffId, string? staffDisplayName,
        string initialMediaMode, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (_sessionByCall.TryGetValue(callId, out var existingId)
                && _sessions.TryGetValue(existingId, out var existing))
            {
                var updated = existing with
                {
                    StaffId = staffId ?? existing.StaffId,
                    StaffDisplayName = staffDisplayName ?? existing.StaffDisplayName,
                    UpdatedAt = DateTimeOffset.UtcNow,
                    StartedAt = existing.StartedAt ?? DateTimeOffset.UtcNow
                };
                _sessions[existingId] = updated;
                return Task.FromResult(updated);
            }

            var display = callerDisplayName ?? "";
            if (PostgresConsultationCatalog.IsGuestCallerId(callerId)
                && !System.Text.RegularExpressions.Regex.IsMatch(display, @"^Khách #\d+$"))
            {
                _guestSeq.TryGetValue(clinicId, out var n);
                n = Math.Max(1, n);
                display = $"Khách #{n}";
                _guestSeq[clinicId] = n + 1;
            }

            var now = DateTimeOffset.UtcNow;
            var session = new ConsultationSession(
                Guid.NewGuid(), callId, clinicId, roomName,
                string.IsNullOrWhiteSpace(initialMediaMode) ? "Audio" : initialMediaMode,
                callerId, display,
                staffId, staffDisplayName,
                now, null, "Active", now, now);
            _sessions[session.Id] = session;
            _sessionByCall[callId] = session.Id;
            return Task.FromResult(session);
        }
    }

    public Task MarkSessionEndedAsync(Guid callId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_sessionByCall.TryGetValue(callId, out var sid)) return Task.CompletedTask;
            if (!_sessions.TryGetValue(sid, out var s)) return Task.CompletedTask;
            _sessions[sid] = s with
            {
                Status = "Ended",
                EndedAt = s.EndedAt ?? DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }
        return Task.CompletedTask;
    }

    public Task<ConsultationSession?> GetSessionByCallIdAsync(Guid callId, CancellationToken ct = default)
    {
        if (_sessionByCall.TryGetValue(callId, out var sid) && _sessions.TryGetValue(sid, out var s))
            return Task.FromResult<ConsultationSession?>(s);
        return Task.FromResult<ConsultationSession?>(null);
    }

    public Task<ConsultationSession?> GetSessionByIdAsync(Guid sessionId, CancellationToken ct = default)
    {
        _sessions.TryGetValue(sessionId, out var s);
        return Task.FromResult(s);
    }

    public Task<IReadOnlyList<ConsultationSession>> ListSessionsByClinicAsync(
        string clinicId, int limit, int offset, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<ConsultationSession>>(_sessions.Values
            .Where(s => string.Equals(s.ClinicId, clinicId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(s => s.UpdatedAt)
            .Skip(Math.Max(0, offset))
            .Take(Math.Clamp(limit, 1, 200))
            .ToList());

    public Task<Guid> InsertMediaAssetAsync(MediaAssetInsert insert, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (insert.Kind is MediaAssetKinds.CallAudio or MediaAssetKinds.DentalVideoClip)
            {
                var hasActive = _assets.Values.Any(a =>
                    a.CallId == insert.CallId
                    && a.Kind == insert.Kind
                    && a.Status is MediaAssetStatus.Requested
                        or MediaAssetStatus.Recording
                        or MediaAssetStatus.Finalizing);
                if (hasActive)
                    throw new MediaAssetConflictException($"Active {insert.Kind} already exists for call.");
            }

            var now = DateTimeOffset.UtcNow;
            var id = insert.Id == Guid.Empty ? Guid.NewGuid() : insert.Id;
            if (_assets.ContainsKey(id))
                throw new MediaAssetConflictException("Asset id already exists.");

            var asset = new MediaAsset(
                id, insert.SessionId, insert.CallId, insert.ClinicId,
                insert.Kind, MediaAssetStatus.Requested,
                insert.CreatedBy, null,
                insert.SourceParticipantId, insert.SourceTrackId,
                now, null, null, null, null,
                insert.RetentionUntil, null, null, null,
                null, null, now, now);
            _assets[id] = asset;
            return Task.FromResult(id);
        }
    }

    public Task<bool> TryMarkRecordingAsync(Guid assetId, string egressId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (a.Status != MediaAssetStatus.Requested) return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Recording,
                EgressId = egressId,
                StartedAt = a.StartedAt ?? now,
                UpdatedAt = now,
                Error = null
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkFinalizingAsync(Guid assetId, string egressId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (a.Status is not (MediaAssetStatus.Recording or MediaAssetStatus.Requested))
                return Task.FromResult(false);
            if (a.EgressId is not null && !string.Equals(a.EgressId, egressId, StringComparison.Ordinal))
                return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Finalizing,
                EgressId = egressId,
                FinalizingStartedAt = a.FinalizingStartedAt ?? now,
                UpdatedAt = now
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkReadyAsync(
        Guid assetId, string egressId, long? durationMs,
        DateTimeOffset endedAt, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (MediaAssetStatus.IsTerminal(a.Status)) return Task.FromResult(false);
            if (a.EgressId is not null && !string.Equals(a.EgressId, egressId, StringComparison.Ordinal))
                return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Ready,
                EgressId = egressId,
                EndedAt = endedAt,
                CompletedAt = now,
                UpdatedAt = now,
                Error = null
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkUploadingAsync(Guid assetId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (a.Status != MediaAssetStatus.Requested) return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Uploading,
                StartedAt = a.StartedAt ?? now,
                UpdatedAt = now
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkSnapshotReadyAsync(
        Guid assetId, DateTimeOffset capturedAt, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (a.Status != MediaAssetStatus.Uploading) return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Ready,
                CapturedAt = capturedAt,
                EndedAt = now,
                CompletedAt = now,
                UpdatedAt = now,
                Error = null
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkFailedAsync(Guid assetId, string? egressId, string error, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (MediaAssetStatus.IsTerminal(a.Status)) return Task.FromResult(false);
            if (egressId is not null && a.EgressId is not null
                && !string.Equals(a.EgressId, egressId, StringComparison.Ordinal))
                return Task.FromResult(false);
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Failed,
                Error = error,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TrySetTerminalSeenAsync(Guid assetId, string egressId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (a.EgressId is not null && !string.Equals(a.EgressId, egressId, StringComparison.Ordinal))
                return Task.FromResult(false);
            if (a.TerminalSeenAt is not null) return Task.FromResult(false);
            _assets[assetId] = a with
            {
                TerminalSeenAt = DateTimeOffset.UtcNow,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkDeletePendingAsync(Guid assetId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.FromResult(false);
            if (a.Status != MediaAssetStatus.Ready) return Task.FromResult(false);
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.DeletePending,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            return Task.FromResult(true);
        }
    }

    public Task MarkDeletedAsync(Guid assetId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            if (!_assets.TryGetValue(assetId, out var a)) return Task.CompletedTask;
            _assets[assetId] = a with
            {
                Status = MediaAssetStatus.Deleted,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }
        return Task.CompletedTask;
    }

    public Task UpsertMediaObjectAsync(
        Guid assetId, string kind, string storageKey,
        string? mimeType, long? bytes, string? etag,
        int? width, int? height, long? durationMs,
        int? bitrateKbps, string? codec,
        CancellationToken ct = default)
    {
        lock (_gate)
        {
            var existing = _objects.Values.FirstOrDefault(o =>
                o.MediaAssetId == assetId
                && string.Equals(o.Kind, kind, StringComparison.OrdinalIgnoreCase));
            var now = DateTimeOffset.UtcNow;
            if (existing is not null)
            {
                _objects[existing.Id] = existing with
                {
                    StorageKey = storageKey,
                    MimeType = mimeType ?? existing.MimeType,
                    Bytes = bytes ?? existing.Bytes,
                    Etag = etag ?? existing.Etag,
                    Width = width ?? existing.Width,
                    Height = height ?? existing.Height,
                    DurationMs = durationMs ?? existing.DurationMs,
                    BitrateKbps = bitrateKbps ?? existing.BitrateKbps,
                    Codec = codec ?? existing.Codec
                };
            }
            else
            {
                var id = Interlocked.Increment(ref _objectSeq);
                _objects[id] = new MediaObject(
                    id, assetId, kind, storageKey,
                    mimeType, bytes, etag, width, height, durationMs, bitrateKbps, codec,
                    now, null);
            }
        }
        return Task.CompletedTask;
    }

    public Task MarkMediaObjectReadyAsync(
        Guid assetId, string kind, long? bytes, string? etag, long? durationMs,
        CancellationToken ct = default)
    {
        lock (_gate)
        {
            var existing = _objects.Values.FirstOrDefault(o =>
                o.MediaAssetId == assetId
                && string.Equals(o.Kind, kind, StringComparison.OrdinalIgnoreCase));
            if (existing is null) return Task.CompletedTask;
            _objects[existing.Id] = existing with
            {
                Bytes = bytes ?? existing.Bytes,
                Etag = etag ?? existing.Etag,
                DurationMs = durationMs ?? existing.DurationMs,
                ReadyAt = DateTimeOffset.UtcNow
            };
        }
        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<MediaObject>> GetObjectsByAssetAsync(Guid assetId, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<MediaObject>>(_objects.Values
            .Where(o => o.MediaAssetId == assetId)
            .ToList());

    public Task<MediaObject?> GetObjectByAssetAndKindAsync(Guid assetId, string kind, CancellationToken ct = default) =>
        Task.FromResult(_objects.Values.FirstOrDefault(o =>
            o.MediaAssetId == assetId
            && string.Equals(o.Kind, kind, StringComparison.OrdinalIgnoreCase)));

    public Task<MediaAsset?> GetAssetByIdAsync(Guid assetId, CancellationToken ct = default)
    {
        _assets.TryGetValue(assetId, out var a);
        return Task.FromResult(a);
    }

    public Task<MediaAsset?> GetAssetByEgressIdAsync(string egressId, CancellationToken ct = default) =>
        Task.FromResult(_assets.Values.FirstOrDefault(a =>
            a.EgressId is not null
            && string.Equals(a.EgressId, egressId, StringComparison.Ordinal)));

    public Task<MediaAsset?> GetActiveAudioAssetAsync(Guid callId, CancellationToken ct = default) =>
        Task.FromResult(_assets.Values.FirstOrDefault(a =>
            a.CallId == callId
            && a.Kind == MediaAssetKinds.CallAudio
            && a.Status is MediaAssetStatus.Requested or MediaAssetStatus.Recording or MediaAssetStatus.Finalizing));

    public Task<MediaAsset?> GetActiveDentalClipAsync(Guid callId, CancellationToken ct = default) =>
        Task.FromResult(_assets.Values.FirstOrDefault(a =>
            a.CallId == callId
            && a.Kind == MediaAssetKinds.DentalVideoClip
            && a.Status is MediaAssetStatus.Requested or MediaAssetStatus.Recording or MediaAssetStatus.Finalizing));

    public Task<IReadOnlyList<MediaAsset>> ListAssetsBySessionAsync(Guid sessionId, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<MediaAsset>>(_assets.Values
            .Where(a => a.SessionId == sessionId)
            .OrderBy(a => a.RequestedAt)
            .ToList());

    public Task<IReadOnlyList<MediaAsset>> ListActiveAssetsByCallAsync(Guid callId, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<MediaAsset>>(_assets.Values
            .Where(a => a.CallId == callId && MediaAssetStatus.IsActive(a.Status))
            .ToList());

    public Task<IReadOnlyList<MediaAsset>> ListStuckAssetsAsync(int limit, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<MediaAsset>>(_assets.Values
            .Where(a => a.Status is MediaAssetStatus.Recording
                or MediaAssetStatus.Finalizing
                or MediaAssetStatus.Uploading)
            .OrderBy(a => a.FinalizingStartedAt ?? a.RequestedAt)
            .Take(Math.Max(1, limit))
            .ToList());

    public Task<IReadOnlyList<MediaAsset>> ListDueForRetentionAsync(int limit, CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        return Task.FromResult<IReadOnlyList<MediaAsset>>(_assets.Values
            .Where(a => a.Status == MediaAssetStatus.Ready
                        && a.RetentionUntil is not null
                        && a.RetentionUntil <= now)
            .OrderBy(a => a.RetentionUntil)
            .Take(Math.Max(1, limit))
            .ToList());
    }

    public Task<IReadOnlyList<MediaAsset>> ListDeletePendingAsync(int limit, CancellationToken ct = default) =>
        Task.FromResult<IReadOnlyList<MediaAsset>>(_assets.Values
            .Where(a => a.Status == MediaAssetStatus.DeletePending)
            .Take(Math.Max(1, limit))
            .ToList());

    public Task<(int audio, int video, int photo)> GetMediaCountsAsync(Guid sessionId, CancellationToken ct = default)
    {
        var assets = _assets.Values.Where(a =>
            a.SessionId == sessionId
            && a.Status is not (MediaAssetStatus.Deleted or MediaAssetStatus.Failed)).ToList();
        var audio = assets.Count(a => a.Kind == MediaAssetKinds.CallAudio && a.Status == MediaAssetStatus.Ready);
        var video = assets.Count(a => a.Kind == MediaAssetKinds.DentalVideoClip && a.Status == MediaAssetStatus.Ready);
        var photo = assets.Count(a => a.Kind == MediaAssetKinds.Snapshot && a.Status == MediaAssetStatus.Ready);
        return Task.FromResult((audio, video, photo));
    }
}

// === PostgreSQL implementation ===

public sealed class PostgresConsultationCatalog(IConfiguration configuration, ILogger<PostgresConsultationCatalog> logger)
    : IConsultationCatalog
{
    private readonly string _connectionString = ResolveConnectionString(configuration);

    public string BackendName => "postgres";

    private static string ResolveConnectionString(IConfiguration configuration)
    {
        var cs = configuration["RECORDING_DB"]
                 ?? configuration["ConnectionStrings:Recording"]
                 ?? configuration.GetConnectionString("Recording");
        if (!string.IsNullOrWhiteSpace(cs))
            return cs;

        var host = configuration["POSTGRES_HOST"] ?? "postgres";
        var port = configuration["POSTGRES_PORT"] ?? "5432";
        var db = configuration["POSTGRES_DB"] ?? "simlydent";
        var user = configuration["POSTGRES_USER"] ?? "simlydent";
        var pass = configuration["POSTGRES_PASSWORD"] ?? "simlydent";
        return $"Host={host};Port={port};Database={db};Username={user};Password={pass}";
    }

    public async Task EnsureSchemaAsync(CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS consultation_sessions (
                id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                call_id              UUID NOT NULL,
                clinic_id            TEXT NOT NULL,
                livekit_room_name    TEXT NOT NULL,
                initial_media_mode   TEXT NOT NULL DEFAULT 'Audio',
                caller_id            TEXT NOT NULL,
                caller_display_name  TEXT NOT NULL DEFAULT '',
                staff_id             TEXT NULL,
                staff_display_name   TEXT NULL,
                started_at           TIMESTAMPTZ NULL,
                ended_at             TIMESTAMPTZ NULL,
                status               TEXT NOT NULL DEFAULT 'Active',
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
                kind                  TEXT NOT NULL,
                status                TEXT NOT NULL,
                created_by            TEXT NULL,
                egress_id             TEXT NULL,
                source_participant_id TEXT NULL,
                source_track_id       TEXT NULL,
                requested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
                started_at            TIMESTAMPTZ NULL,
                ended_at              TIMESTAMPTZ NULL,
                captured_at           TIMESTAMPTZ NULL,
                completed_at          TIMESTAMPTZ NULL,
                retention_until       TIMESTAMPTZ NULL,
                label                 TEXT NULL,
                note                  TEXT NULL,
                error                 TEXT NULL,
                finalizing_started_at TIMESTAMPTZ NULL,
                terminal_seen_at      TIMESTAMPTZ NULL,
                created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            CREATE UNIQUE INDEX IF NOT EXISTS uix_one_active_audio
                ON media_assets (call_id)
                WHERE kind = 'CallAudio'
                  AND status IN ('Requested', 'Recording', 'Finalizing');

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
                kind            TEXT NOT NULL,
                storage_key     TEXT NOT NULL,
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

            -- Clinic-scoped sequential guest labels: Khách #1, #2, …
            CREATE TABLE IF NOT EXISTS clinic_guest_counters (
                clinic_id TEXT PRIMARY KEY,
                next_seq  INT NOT NULL DEFAULT 1
            );

            -- One-time style backfill: assign sequential display names for guest callers
            -- (raw visitor ids, hex-style Khách #ABC123, empty names).
            WITH guests AS (
                SELECT id, clinic_id,
                    ROW_NUMBER() OVER (PARTITION BY clinic_id ORDER BY created_at ASC, id ASC) AS rn
                FROM consultation_sessions
                WHERE caller_id ILIKE 'visitor:%'
                   OR caller_id ~* '^v[a-z0-9]{1,3}$'
            )
            UPDATE consultation_sessions s
            SET caller_display_name = 'Khách #' || g.rn::text
            FROM guests g
            WHERE s.id = g.id
              AND (
                    s.caller_display_name IS NULL
                 OR btrim(s.caller_display_name) = ''
                 OR s.caller_display_name = s.caller_id
                 OR s.caller_display_name ILIKE 'visitor:%'
                 -- Not already sequential Khách #1, #2, … (hex-style labels get replaced)
                 OR s.caller_display_name !~ '^Khách #[0-9]+$'
              );

            INSERT INTO clinic_guest_counters (clinic_id, next_seq)
            SELECT clinic_id, COALESCE(MAX(
                CASE WHEN caller_display_name ~ '^Khách #[0-9]+$'
                     THEN NULLIF(regexp_replace(caller_display_name, '^Khách #', ''), '')::int
                     ELSE NULL END
            ), 0) + 1
            FROM consultation_sessions
            GROUP BY clinic_id
            ON CONFLICT (clinic_id) DO UPDATE
            SET next_seq = GREATEST(clinic_guest_counters.next_seq, EXCLUDED.next_seq);
            """;
        await cmd.ExecuteNonQueryAsync(ct);
        logger.LogInformation("Consultation media catalog schema ensured (PostgreSQL).");
    }

    /// <summary>True for embed visitors and short demo queue visitors (VA/VB).</summary>
    internal static bool IsGuestCallerId(string? callerId)
    {
        if (string.IsNullOrWhiteSpace(callerId)) return false;
        if (callerId.StartsWith("visitor:", StringComparison.OrdinalIgnoreCase)) return true;
        return callerId.Length is >= 2 and <= 4
               && (callerId[0] is 'V' or 'v')
               && callerId.Skip(1).All(char.IsLetterOrDigit);
    }

    private async Task<string> AllocateGuestDisplayNameAsync(
        NpgsqlConnection conn, string clinicId, CancellationToken ct)
    {
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO clinic_guest_counters (clinic_id, next_seq)
            VALUES (@clinic, 1)
            ON CONFLICT (clinic_id) DO NOTHING;

            UPDATE clinic_guest_counters
            SET next_seq = next_seq + 1
            WHERE clinic_id = @clinic
            RETURNING next_seq - 1;
            """;
        cmd.Parameters.AddWithValue("clinic", clinicId);
        var result = await cmd.ExecuteScalarAsync(ct);
        var n = result is int i ? i : Convert.ToInt32(result);
        if (n < 1) n = 1;
        return $"Khách #{n}";
    }

    public async Task<ConsultationSession> EnsureSessionAsync(
        Guid callId, string clinicId, string roomName,
        string callerId, string callerDisplayName,
        string? staffId, string? staffDisplayName,
        string initialMediaMode, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);

        // Guest callers always get clinic sequential label Khách #1, #2, …
        var callerName = callerDisplayName ?? "";
        if (IsGuestCallerId(callerId))
        {
            // Keep existing sequential label if already assigned (idempotent re-ensure)
            await using (var check = conn.CreateCommand())
            {
                check.CommandText = """
                    SELECT caller_display_name FROM consultation_sessions WHERE call_id = @callId
                    """;
                check.Parameters.AddWithValue("callId", callId);
                var existing = await check.ExecuteScalarAsync(ct) as string;
                if (!string.IsNullOrWhiteSpace(existing)
                    && System.Text.RegularExpressions.Regex.IsMatch(existing, @"^Khách #\d+$"))
                {
                    callerName = existing;
                }
                else
                {
                    callerName = await AllocateGuestDisplayNameAsync(conn, clinicId, ct);
                }
            }
        }

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO consultation_sessions (
                id, call_id, clinic_id, livekit_room_name, initial_media_mode,
                caller_id, caller_display_name, staff_id, staff_display_name,
                started_at, status, created_at, updated_at)
            VALUES (
                @id, @callId, @clinic, @room, @mode,
                @callerId, @callerName, @staffId, @staffName,
                @now, 'Active', @now, @now)
            ON CONFLICT (call_id) DO UPDATE SET
                updated_at = now(),
                staff_id = COALESCE(EXCLUDED.staff_id, consultation_sessions.staff_id),
                staff_display_name = COALESCE(EXCLUDED.staff_display_name, consultation_sessions.staff_display_name),
                started_at = COALESCE(consultation_sessions.started_at, EXCLUDED.started_at),
                -- Upgrade legacy raw/hex labels to sequential when already assigned above path re-ran
                caller_display_name = CASE
                    WHEN consultation_sessions.caller_display_name ~ '^Khách #[0-9]+$'
                        THEN consultation_sessions.caller_display_name
                    WHEN EXCLUDED.caller_display_name ~ '^Khách #[0-9]+$'
                        THEN EXCLUDED.caller_display_name
                    ELSE consultation_sessions.caller_display_name
                END
            RETURNING id, call_id, clinic_id, livekit_room_name, initial_media_mode,
                caller_id, caller_display_name, staff_id, staff_display_name,
                started_at, ended_at, status, created_at, updated_at
            """;
        var now = DateTimeOffset.UtcNow;
        cmd.Parameters.AddWithValue("id", Guid.NewGuid());
        cmd.Parameters.AddWithValue("callId", callId);
        cmd.Parameters.AddWithValue("clinic", clinicId);
        cmd.Parameters.AddWithValue("room", roomName);
        cmd.Parameters.AddWithValue("mode", string.IsNullOrWhiteSpace(initialMediaMode) ? "Audio" : initialMediaMode);
        cmd.Parameters.AddWithValue("callerId", callerId);
        cmd.Parameters.AddWithValue("callerName", callerName);
        cmd.Parameters.AddWithValue("staffId", (object?)staffId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("staffName", (object?)staffDisplayName ?? DBNull.Value);
        cmd.Parameters.AddWithValue("now", now);

        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct))
            throw new InvalidOperationException("EnsureSession returned no row.");
        return ReadSession(reader);
    }

    public async Task MarkSessionEndedAsync(Guid callId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE consultation_sessions
            SET status = 'Ended',
                ended_at = COALESCE(ended_at, @now),
                updated_at = @now
            WHERE call_id = @callId
            """;
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("callId", callId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<ConsultationSession?> GetSessionByCallIdAsync(Guid callId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, call_id, clinic_id, livekit_room_name, initial_media_mode,
                caller_id, caller_display_name, staff_id, staff_display_name,
                started_at, ended_at, status, created_at, updated_at
            FROM consultation_sessions WHERE call_id = @callId
            """;
        cmd.Parameters.AddWithValue("callId", callId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadSession(reader);
    }

    public async Task<ConsultationSession?> GetSessionByIdAsync(Guid sessionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, call_id, clinic_id, livekit_room_name, initial_media_mode,
                caller_id, caller_display_name, staff_id, staff_display_name,
                started_at, ended_at, status, created_at, updated_at
            FROM consultation_sessions WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("id", sessionId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadSession(reader);
    }

    public async Task<IReadOnlyList<ConsultationSession>> ListSessionsByClinicAsync(
        string clinicId, int limit, int offset, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, call_id, clinic_id, livekit_room_name, initial_media_mode,
                caller_id, caller_display_name, staff_id, staff_display_name,
                started_at, ended_at, status, created_at, updated_at
            FROM consultation_sessions
            WHERE clinic_id = @clinic
            ORDER BY updated_at DESC
            LIMIT @limit OFFSET @offset
            """;
        cmd.Parameters.AddWithValue("clinic", clinicId);
        cmd.Parameters.AddWithValue("limit", Math.Clamp(limit, 1, 200));
        cmd.Parameters.AddWithValue("offset", Math.Max(0, offset));
        var list = new List<ConsultationSession>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadSession(reader));
        return list;
    }

    public async Task<Guid> InsertMediaAssetAsync(MediaAssetInsert insert, CancellationToken ct = default)
    {
        var id = insert.Id == Guid.Empty ? Guid.NewGuid() : insert.Id;
        var now = DateTimeOffset.UtcNow;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO media_assets (
                id, session_id, call_id, clinic_id, kind, status, created_by,
                source_participant_id, source_track_id, requested_at, retention_until,
                created_at, updated_at)
            VALUES (
                @id, @session, @call, @clinic, @kind, @status, @createdBy,
                @srcPart, @srcTrack, @now, @retention, @now, @now)
            """;
        cmd.Parameters.AddWithValue("id", id);
        cmd.Parameters.AddWithValue("session", insert.SessionId);
        cmd.Parameters.AddWithValue("call", insert.CallId);
        cmd.Parameters.AddWithValue("clinic", insert.ClinicId);
        cmd.Parameters.AddWithValue("kind", insert.Kind);
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Requested);
        cmd.Parameters.AddWithValue("createdBy", (object?)insert.CreatedBy ?? DBNull.Value);
        cmd.Parameters.AddWithValue("srcPart", (object?)insert.SourceParticipantId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("srcTrack", (object?)insert.SourceTrackId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("retention", (object?)insert.RetentionUntil ?? DBNull.Value);

        try
        {
            await cmd.ExecuteNonQueryAsync(ct);
            return id;
        }
        catch (PostgresException ex) when (ex.SqlState == PostgresErrorCodes.UniqueViolation)
        {
            throw new MediaAssetConflictException(
                $"Active {insert.Kind} already exists for call {insert.CallId}.");
        }
    }

    public async Task<bool> TryMarkRecordingAsync(Guid assetId, string egressId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        var now = DateTimeOffset.UtcNow;
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status, egress_id = @egress, started_at = COALESCE(started_at, @now),
                updated_at = @now, error = NULL
            WHERE id = @id AND status = @from
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Recording);
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("from", MediaAssetStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TryMarkFinalizingAsync(Guid assetId, string egressId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        var now = DateTimeOffset.UtcNow;
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status,
                egress_id = @egress,
                finalizing_started_at = COALESCE(finalizing_started_at, @now),
                updated_at = @now
            WHERE id = @id
              AND status IN (@from1, @from2)
              AND (egress_id IS NULL OR egress_id = @egress)
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Finalizing);
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("from1", MediaAssetStatus.Recording);
        cmd.Parameters.AddWithValue("from2", MediaAssetStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TryMarkReadyAsync(
        Guid assetId, string egressId, long? durationMs,
        DateTimeOffset endedAt, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        var now = DateTimeOffset.UtcNow;
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status, egress_id = @egress,
                ended_at = @ended, completed_at = @now, updated_at = @now, error = NULL
            WHERE id = @id
              AND status IN (@s1, @s2, @s3)
              AND (egress_id IS NULL OR egress_id = @egress)
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Ready);
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("ended", endedAt);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("s1", MediaAssetStatus.Finalizing);
        cmd.Parameters.AddWithValue("s2", MediaAssetStatus.Recording);
        cmd.Parameters.AddWithValue("s3", MediaAssetStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TryMarkUploadingAsync(Guid assetId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        var now = DateTimeOffset.UtcNow;
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status, started_at = COALESCE(started_at, @now), updated_at = @now
            WHERE id = @id AND status = @from
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Uploading);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("from", MediaAssetStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TryMarkSnapshotReadyAsync(
        Guid assetId, DateTimeOffset capturedAt, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        var now = DateTimeOffset.UtcNow;
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status, captured_at = @captured, ended_at = @now,
                completed_at = @now, updated_at = @now, error = NULL
            WHERE id = @id AND status = @from
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Ready);
        cmd.Parameters.AddWithValue("captured", capturedAt);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("from", MediaAssetStatus.Uploading);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TryMarkFailedAsync(Guid assetId, string? egressId, string error, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status, error = @error, updated_at = @now
            WHERE id = @id
              AND status NOT IN (@t1, @t2, @t3, @t4)
              AND (@egress IS NULL OR egress_id IS NULL OR egress_id = @egress)
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Failed);
        cmd.Parameters.AddWithValue("error", error);
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("t1", MediaAssetStatus.Ready);
        cmd.Parameters.AddWithValue("t2", MediaAssetStatus.Failed);
        cmd.Parameters.AddWithValue("t3", MediaAssetStatus.Deleted);
        cmd.Parameters.AddWithValue("t4", MediaAssetStatus.DeletePending);
        cmd.Parameters.AddWithValue("egress", (object?)egressId ?? DBNull.Value);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TrySetTerminalSeenAsync(Guid assetId, string egressId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE media_assets
            SET terminal_seen_at = COALESCE(terminal_seen_at, @now), updated_at = @now
            WHERE id = @id
              AND (egress_id IS NULL OR egress_id = @egress)
              AND terminal_seen_at IS NULL
            """;
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("egress", egressId);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task<bool> TryMarkDeletePendingAsync(Guid assetId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE media_assets
            SET status = @status, updated_at = @now
            WHERE id = @id AND status = @from
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.DeletePending);
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", assetId);
        cmd.Parameters.AddWithValue("from", MediaAssetStatus.Ready);
        return await cmd.ExecuteNonQueryAsync(ct) > 0;
    }

    public async Task MarkDeletedAsync(Guid assetId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE media_assets SET status = @status, updated_at = @now WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("status", MediaAssetStatus.Deleted);
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", assetId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task UpsertMediaObjectAsync(
        Guid assetId, string kind, string storageKey,
        string? mimeType, long? bytes, string? etag,
        int? width, int? height, long? durationMs,
        int? bitrateKbps, string? codec,
        CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            INSERT INTO media_objects (
                media_asset_id, kind, storage_key, mime_type, bytes, etag,
                width, height, duration_ms, bitrate_kbps, codec, created_at)
            VALUES (
                @aid, @kind, @key, @mime, @bytes, @etag,
                @w, @h, @dur, @br, @codec, @now)
            ON CONFLICT (media_asset_id, kind) DO UPDATE SET
                storage_key = EXCLUDED.storage_key,
                mime_type = COALESCE(EXCLUDED.mime_type, media_objects.mime_type),
                bytes = COALESCE(EXCLUDED.bytes, media_objects.bytes),
                etag = COALESCE(EXCLUDED.etag, media_objects.etag),
                width = COALESCE(EXCLUDED.width, media_objects.width),
                height = COALESCE(EXCLUDED.height, media_objects.height),
                duration_ms = COALESCE(EXCLUDED.duration_ms, media_objects.duration_ms),
                bitrate_kbps = COALESCE(EXCLUDED.bitrate_kbps, media_objects.bitrate_kbps),
                codec = COALESCE(EXCLUDED.codec, media_objects.codec)
            """;
        cmd.Parameters.AddWithValue("aid", assetId);
        cmd.Parameters.AddWithValue("kind", kind);
        cmd.Parameters.AddWithValue("key", storageKey);
        cmd.Parameters.AddWithValue("mime", (object?)mimeType ?? DBNull.Value);
        cmd.Parameters.AddWithValue("bytes", (object?)bytes ?? DBNull.Value);
        cmd.Parameters.AddWithValue("etag", (object?)etag ?? DBNull.Value);
        cmd.Parameters.AddWithValue("w", (object?)width ?? DBNull.Value);
        cmd.Parameters.AddWithValue("h", (object?)height ?? DBNull.Value);
        cmd.Parameters.AddWithValue("dur", (object?)durationMs ?? DBNull.Value);
        cmd.Parameters.AddWithValue("br", (object?)bitrateKbps ?? DBNull.Value);
        cmd.Parameters.AddWithValue("codec", (object?)codec ?? DBNull.Value);
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task MarkMediaObjectReadyAsync(
        Guid assetId, string kind, long? bytes, string? etag, long? durationMs,
        CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE media_objects
            SET ready_at = COALESCE(ready_at, @now),
                bytes = COALESCE(@bytes, bytes),
                etag = COALESCE(@etag, etag),
                duration_ms = COALESCE(@dur, duration_ms)
            WHERE media_asset_id = @aid AND kind = @kind
            """;
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("bytes", (object?)bytes ?? DBNull.Value);
        cmd.Parameters.AddWithValue("etag", (object?)etag ?? DBNull.Value);
        cmd.Parameters.AddWithValue("dur", (object?)durationMs ?? DBNull.Value);
        cmd.Parameters.AddWithValue("aid", assetId);
        cmd.Parameters.AddWithValue("kind", kind);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<IReadOnlyList<MediaObject>> GetObjectsByAssetAsync(Guid assetId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, media_asset_id, kind, storage_key, mime_type, bytes, etag,
                width, height, duration_ms, bitrate_kbps, codec, created_at, ready_at
            FROM media_objects WHERE media_asset_id = @aid
            """;
        cmd.Parameters.AddWithValue("aid", assetId);
        var list = new List<MediaObject>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadObject(reader));
        return list;
    }

    public async Task<MediaObject?> GetObjectByAssetAndKindAsync(Guid assetId, string kind, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT id, media_asset_id, kind, storage_key, mime_type, bytes, etag,
                width, height, duration_ms, bitrate_kbps, codec, created_at, ready_at
            FROM media_objects WHERE media_asset_id = @aid AND kind = @kind
            """;
        cmd.Parameters.AddWithValue("aid", assetId);
        cmd.Parameters.AddWithValue("kind", kind);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadObject(reader);
    }

    public async Task<MediaAsset?> GetAssetByIdAsync(Guid assetId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + " WHERE id = @id";
        cmd.Parameters.AddWithValue("id", assetId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadAsset(reader);
    }

    public async Task<MediaAsset?> GetAssetByEgressIdAsync(string egressId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + " WHERE egress_id = @egress LIMIT 1";
        cmd.Parameters.AddWithValue("egress", egressId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadAsset(reader);
    }

    public async Task<MediaAsset?> GetActiveAudioAssetAsync(Guid callId, CancellationToken ct = default) =>
        await GetActiveByKindAsync(callId, MediaAssetKinds.CallAudio, ct);

    public async Task<MediaAsset?> GetActiveDentalClipAsync(Guid callId, CancellationToken ct = default) =>
        await GetActiveByKindAsync(callId, MediaAssetKinds.DentalVideoClip, ct);

    private async Task<MediaAsset?> GetActiveByKindAsync(Guid callId, string kind, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + """
             WHERE call_id = @call AND kind = @kind
              AND status IN ('Requested', 'Recording', 'Finalizing')
            LIMIT 1
            """;
        cmd.Parameters.AddWithValue("call", callId);
        cmd.Parameters.AddWithValue("kind", kind);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return ReadAsset(reader);
    }

    public async Task<IReadOnlyList<MediaAsset>> ListAssetsBySessionAsync(Guid sessionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + " WHERE session_id = @sid ORDER BY requested_at";
        cmd.Parameters.AddWithValue("sid", sessionId);
        var list = new List<MediaAsset>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadAsset(reader));
        return list;
    }

    public async Task<IReadOnlyList<MediaAsset>> ListActiveAssetsByCallAsync(Guid callId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + """
             WHERE call_id = @call
              AND status IN ('Requested', 'Recording', 'Finalizing', 'Uploading')
            """;
        cmd.Parameters.AddWithValue("call", callId);
        var list = new List<MediaAsset>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadAsset(reader));
        return list;
    }

    public async Task<IReadOnlyList<MediaAsset>> ListStuckAssetsAsync(int limit, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + """
             WHERE status IN ('Recording', 'Finalizing', 'Uploading')
            ORDER BY finalizing_started_at NULLS LAST, requested_at
            LIMIT @limit
            """;
        cmd.Parameters.AddWithValue("limit", Math.Max(1, limit));
        var list = new List<MediaAsset>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadAsset(reader));
        return list;
    }

    public async Task<IReadOnlyList<MediaAsset>> ListDueForRetentionAsync(int limit, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + """
             WHERE status = 'Ready'
              AND retention_until IS NOT NULL
              AND retention_until <= @now
            ORDER BY retention_until
            LIMIT @limit
            """;
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("limit", Math.Max(1, limit));
        var list = new List<MediaAsset>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadAsset(reader));
        return list;
    }

    public async Task<IReadOnlyList<MediaAsset>> ListDeletePendingAsync(int limit, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectAssetSql + """
             WHERE status = 'DeletePending'
            LIMIT @limit
            """;
        cmd.Parameters.AddWithValue("limit", Math.Max(1, limit));
        var list = new List<MediaAsset>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(ReadAsset(reader));
        return list;
    }

    public async Task<(int audio, int video, int photo)> GetMediaCountsAsync(Guid sessionId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT
                COUNT(*) FILTER (WHERE kind = 'CallAudio' AND status = 'Ready') AS audio,
                COUNT(*) FILTER (WHERE kind = 'DentalVideoClip' AND status = 'Ready') AS video,
                COUNT(*) FILTER (WHERE kind = 'Snapshot' AND status = 'Ready') AS photo
            FROM media_assets
            WHERE session_id = @sid
            """;
        cmd.Parameters.AddWithValue("sid", sessionId);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return (0, 0, 0);
        return (reader.GetInt32(0), reader.GetInt32(1), reader.GetInt32(2));
    }

    private const string SelectAssetSql = """
        SELECT id, session_id, call_id, clinic_id, kind, status, created_by, egress_id,
            source_participant_id, source_track_id, requested_at, started_at, ended_at,
            captured_at, completed_at, retention_until, label, note, error,
            finalizing_started_at, terminal_seen_at, created_at, updated_at
        FROM media_assets
        """;

    private static ConsultationSession ReadSession(NpgsqlDataReader r) => new(
        r.GetGuid(0), r.GetGuid(1), r.GetString(2), r.GetString(3), r.GetString(4),
        r.GetString(5), r.IsDBNull(6) ? "" : r.GetString(6),
        r.IsDBNull(7) ? null : r.GetString(7),
        r.IsDBNull(8) ? null : r.GetString(8),
        r.IsDBNull(9) ? null : r.GetFieldValue<DateTimeOffset>(9),
        r.IsDBNull(10) ? null : r.GetFieldValue<DateTimeOffset>(10),
        r.GetString(11),
        r.GetFieldValue<DateTimeOffset>(12),
        r.GetFieldValue<DateTimeOffset>(13));

    private static MediaAsset ReadAsset(NpgsqlDataReader r) => new(
        r.GetGuid(0), r.GetGuid(1), r.GetGuid(2), r.GetString(3),
        r.GetString(4), r.GetString(5),
        r.IsDBNull(6) ? null : r.GetString(6),
        r.IsDBNull(7) ? null : r.GetString(7),
        r.IsDBNull(8) ? null : r.GetString(8),
        r.IsDBNull(9) ? null : r.GetString(9),
        r.GetFieldValue<DateTimeOffset>(10),
        r.IsDBNull(11) ? null : r.GetFieldValue<DateTimeOffset>(11),
        r.IsDBNull(12) ? null : r.GetFieldValue<DateTimeOffset>(12),
        r.IsDBNull(13) ? null : r.GetFieldValue<DateTimeOffset>(13),
        r.IsDBNull(14) ? null : r.GetFieldValue<DateTimeOffset>(14),
        r.IsDBNull(15) ? null : r.GetFieldValue<DateTimeOffset>(15),
        r.IsDBNull(16) ? null : r.GetString(16),
        r.IsDBNull(17) ? null : r.GetString(17),
        r.IsDBNull(18) ? null : r.GetString(18),
        r.IsDBNull(19) ? null : r.GetFieldValue<DateTimeOffset>(19),
        r.IsDBNull(20) ? null : r.GetFieldValue<DateTimeOffset>(20),
        r.GetFieldValue<DateTimeOffset>(21),
        r.GetFieldValue<DateTimeOffset>(22));

    private static MediaObject ReadObject(NpgsqlDataReader r) => new(
        r.GetInt64(0), r.GetGuid(1), r.GetString(2), r.GetString(3),
        r.IsDBNull(4) ? null : r.GetString(4),
        r.IsDBNull(5) ? null : r.GetInt64(5),
        r.IsDBNull(6) ? null : r.GetString(6),
        r.IsDBNull(7) ? null : r.GetInt32(7),
        r.IsDBNull(8) ? null : r.GetInt32(8),
        r.IsDBNull(9) ? null : r.GetInt64(9),
        r.IsDBNull(10) ? null : r.GetInt32(10),
        r.IsDBNull(11) ? null : r.GetString(11),
        r.GetFieldValue<DateTimeOffset>(12),
        r.IsDBNull(13) ? null : r.GetFieldValue<DateTimeOffset>(13));
}

public static class ConsultationCatalogFactory
{
    public static IConsultationCatalog Create(IServiceProvider sp)
    {
        var config = sp.GetRequiredService<IConfiguration>();
        var hasDb = !string.IsNullOrWhiteSpace(config["RECORDING_DB"])
                    || !string.IsNullOrWhiteSpace(config["ConnectionStrings:Recording"])
                    || !string.IsNullOrWhiteSpace(config.GetConnectionString("Recording"))
                    || !string.IsNullOrWhiteSpace(config["POSTGRES_HOST"]);
        // Prefer same backend as recording catalog when postgres is configured.
        var catalogBackend = (config["RECORDING_CATALOG"] ?? "").Trim().ToLowerInvariant();
        if (catalogBackend is "memory")
            return ActivatorUtilities.CreateInstance<MemoryConsultationCatalog>(sp);
        if (hasDb || catalogBackend is "postgres" or "pg")
            return ActivatorUtilities.CreateInstance<PostgresConsultationCatalog>(sp);
        return ActivatorUtilities.CreateInstance<MemoryConsultationCatalog>(sp);
    }
}
