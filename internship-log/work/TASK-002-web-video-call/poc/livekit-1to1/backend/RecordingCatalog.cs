using System.Collections.Concurrent;
using Npgsql;

namespace LiveKitPoc.Api;

/// <summary>
/// Durable recording ledger status (production state machine).
/// CallSession still uses PoC strings (Starting/Complete/…); map at the boundary.
/// </summary>
public static class RecordingLedgerStatus
{
    public const string Requested = "Requested";
    public const string Recording = "Recording";
    public const string Finalizing = "Finalizing";
    public const string Ready = "Ready";
    public const string DeletePending = "DeletePending";
    public const string Deleted = "Deleted";
    public const string Failed = "Failed";

    public const string CompletionLimitReached = "LimitReached";

    /// <summary>UI / CallSession compatibility (Phase 3 PoC strings).</summary>
    public static string ToUiStatus(string ledgerStatus) => ledgerStatus switch
    {
        Requested => "Starting",
        Recording => "Recording",
        Finalizing => "Stopping",
        Ready => "Complete",
        DeletePending => "Complete",
        Deleted => "Deleted",
        Failed => "Failed",
        _ => ledgerStatus
    };

    public static bool IsDownloadable(string ledgerStatus) =>
        ledgerStatus is Ready;

    public static bool IsActive(string ledgerStatus) =>
        ledgerStatus is Requested or Recording or Finalizing;

    public static bool IsTerminal(string ledgerStatus) =>
        ledgerStatus is Ready or Failed or Deleted or DeletePending;
}

public sealed record RecordingRecord
{
    public required string Id { get; init; }
    public required string ClinicId { get; init; }
    public required Guid CallId { get; init; }
    public string? EgressId { get; init; }
    public required string Status { get; init; }
    public required string Mode { get; init; }
    public string? Error { get; init; }
    public string? CompletionReason { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public DateTimeOffset? RetentionUntil { get; init; }
    public DateTimeOffset? FinalizingStartedAt { get; init; }
    public DateTimeOffset? TerminalSeenAt { get; init; }
    public string? CallerId { get; init; }
    public string? AssignedStaffId { get; init; }
    public string? CallStatus { get; init; }
    public string? ConsentStatus { get; init; }
    public string? StorageKey { get; init; }
    public string? ObjectKind { get; init; }
    public long? Bytes { get; init; }
    public string? Etag { get; init; }
    public long? DurationMs { get; init; }
    /// <summary>Local egress file name (lab path materialize).</summary>
    public string? FileName { get; init; }
}

public interface IRecordingCatalog
{
    string BackendName { get; }

    Task EnsureSchemaAsync(CancellationToken cancellationToken = default);

    Task InsertRequestedAsync(
        string recordingId,
        string clinicId,
        Guid callId,
        string mode,
        string storageKey,
        string objectKind,
        DateTimeOffset? retentionUntil,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        string? fileName = null,
        CancellationToken cancellationToken = default);

    /// <summary>Requested → Recording. Returns true if row changed.</summary>
    Task<bool> TryMarkRecordingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default);

    /// <summary>Recording|Requested → Finalizing; sets finalizing_started_at once. Correlates egress_id.</summary>
    Task<bool> TryMarkFinalizingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default);

    /// <summary>Finalizing|Recording|Requested → Ready when egress_id matches.</summary>
    Task<bool> TryMarkReadyAsync(
        string recordingId,
        string egressId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        string? completionReason = null,
        CancellationToken cancellationToken = default);

    /// <summary>Only from Requested|Recording|Finalizing → Failed. Failed is terminal (no re-update).</summary>
    Task<bool> TryMarkFailedAsync(string recordingId, string egressId, string error, CancellationToken cancellationToken = default);

    /// <summary>Set terminal_seen_at once when COMPLETE/LIMIT first observed (object may still be missing).</summary>
    Task<bool> TrySetTerminalSeenAsync(string recordingId, string egressId, CancellationToken cancellationToken = default);

    Task MarkDeletedAsync(string recordingId, CancellationToken cancellationToken = default);

    Task UpdateCallSnapshotAsync(
        string recordingId,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        CancellationToken cancellationToken = default);

    Task SetFileNameAsync(string recordingId, string fileName, CancellationToken cancellationToken = default);

    Task<RecordingRecord?> GetByIdAsync(string recordingId, CancellationToken cancellationToken = default);

    Task<RecordingRecord?> GetByEgressIdAsync(string egressId, CancellationToken cancellationToken = default);

    Task<RecordingRecord?> GetLatestByCallAsync(Guid callId, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<RecordingRecord>> ListByClinicAsync(string clinicId, CancellationToken cancellationToken = default);

    /// <summary>Rows in Finalizing (and optionally Recording) for reconcile. Does not use updated_at as sole clock.</summary>
    Task<IReadOnlyList<RecordingRecord>> ListStuckAsync(int limit, CancellationToken cancellationToken = default);

    // ---- Compatibility wrappers (legacy call sites) ----

    Task MarkRecordingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default) =>
        TryMarkRecordingAsync(recordingId, egressId, cancellationToken);

    Task MarkFinalizingAsync(string recordingId, CancellationToken cancellationToken = default) =>
        Task.CompletedTask; // prefer TryMarkFinalizingAsync with egressId

    Task MarkReadyAsync(
        string recordingId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        CancellationToken cancellationToken = default) =>
        Task.CompletedTask; // prefer TryMarkReadyAsync with egressId

    Task MarkFailedAsync(string recordingId, string error, CancellationToken cancellationToken = default) =>
        Task.CompletedTask; // prefer TryMarkFailedAsync with egressId
}

/// <summary>In-process fallback when RECORDING_DB is unset (lab only).</summary>
public sealed class MemoryRecordingCatalog : IRecordingCatalog
{
    private readonly ConcurrentDictionary<string, RecordingRecord> _byId = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public string BackendName => "memory";

    public Task EnsureSchemaAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

    public Task InsertRequestedAsync(
        string recordingId,
        string clinicId,
        Guid callId,
        string mode,
        string storageKey,
        string objectKind,
        DateTimeOffset? retentionUntil,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        string? fileName = null,
        CancellationToken cancellationToken = default)
    {
        var now = DateTimeOffset.UtcNow;
        _byId[recordingId] = new RecordingRecord
        {
            Id = recordingId,
            ClinicId = clinicId,
            CallId = callId,
            Status = RecordingLedgerStatus.Requested,
            Mode = mode,
            CreatedAt = now,
            UpdatedAt = now,
            RetentionUntil = retentionUntil,
            CallerId = callerId,
            AssignedStaffId = assignedStaffId,
            CallStatus = callStatus,
            ConsentStatus = consentStatus,
            StorageKey = storageKey,
            ObjectKind = objectKind,
            FileName = fileName
        };
        return Task.CompletedTask;
    }

    public Task<bool> TryMarkRecordingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.FromResult(false);
            if (r.Status != RecordingLedgerStatus.Requested) return Task.FromResult(false);
            _byId[recordingId] = r with
            {
                EgressId = egressId,
                Status = RecordingLedgerStatus.Recording,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkFinalizingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.FromResult(false);
            if (r.Status is not (RecordingLedgerStatus.Recording or RecordingLedgerStatus.Requested))
                return Task.FromResult(false);
            if (r.EgressId is not null && !string.Equals(r.EgressId, egressId, StringComparison.Ordinal))
                return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _byId[recordingId] = r with
            {
                EgressId = egressId,
                Status = RecordingLedgerStatus.Finalizing,
                FinalizingStartedAt = r.FinalizingStartedAt ?? now,
                UpdatedAt = now
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkReadyAsync(
        string recordingId,
        string egressId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        string? completionReason = null,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.FromResult(false);
            if (r.Status is not (RecordingLedgerStatus.Finalizing or RecordingLedgerStatus.Recording or RecordingLedgerStatus.Requested))
                return Task.FromResult(false);
            if (!string.Equals(r.EgressId, egressId, StringComparison.Ordinal))
                return Task.FromResult(false);
            var now = DateTimeOffset.UtcNow;
            _byId[recordingId] = r with
            {
                Status = RecordingLedgerStatus.Ready,
                StorageKey = storageKey,
                Bytes = bytes ?? r.Bytes,
                Etag = etag ?? r.Etag,
                DurationMs = durationMs ?? r.DurationMs,
                CompletionReason = completionReason ?? r.CompletionReason,
                CompletedAt = now,
                UpdatedAt = now
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TryMarkFailedAsync(string recordingId, string egressId, string error, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.FromResult(false);
            if (r.Status is not (RecordingLedgerStatus.Requested or RecordingLedgerStatus.Recording or RecordingLedgerStatus.Finalizing))
                return Task.FromResult(false);
            var want = egressId ?? "";
            if (want.Length > 0)
            {
                if (!string.Equals(r.EgressId, want, StringComparison.Ordinal))
                    return Task.FromResult(false);
            }
            else if (r.EgressId is not null)
            {
                return Task.FromResult(false);
            }
            var msg = error.Length > 2000 ? error[..2000] : error;
            _byId[recordingId] = r with
            {
                Status = RecordingLedgerStatus.Failed,
                Error = msg,
                UpdatedAt = DateTimeOffset.UtcNow
            };
            return Task.FromResult(true);
        }
    }

    public Task<bool> TrySetTerminalSeenAsync(string recordingId, string egressId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.FromResult(false);
            if (!string.Equals(r.EgressId, egressId, StringComparison.Ordinal)) return Task.FromResult(false);
            if (r.TerminalSeenAt is not null) return Task.FromResult(false);
            if (RecordingLedgerStatus.IsTerminal(r.Status)) return Task.FromResult(false);
            _byId[recordingId] = r with
            {
                TerminalSeenAt = DateTimeOffset.UtcNow
                // do not bump UpdatedAt solely for clock set if avoidable — plan says updated_at not timeout; still ok to set lightly
            };
            return Task.FromResult(true);
        }
    }

    public Task MarkDeletedAsync(string recordingId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.CompletedTask;
            _byId[recordingId] = r with
            {
                Status = RecordingLedgerStatus.Deleted,
                StorageKey = null,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }
        return Task.CompletedTask;
    }

    public Task UpdateCallSnapshotAsync(
        string recordingId,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.CompletedTask;
            _byId[recordingId] = r with
            {
                CallerId = callerId ?? r.CallerId,
                AssignedStaffId = assignedStaffId ?? r.AssignedStaffId,
                CallStatus = callStatus ?? r.CallStatus,
                ConsentStatus = consentStatus ?? r.ConsentStatus,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }
        return Task.CompletedTask;
    }

    public Task SetFileNameAsync(string recordingId, string fileName, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var r)) return Task.CompletedTask;
            _byId[recordingId] = r with { FileName = fileName };
        }
        return Task.CompletedTask;
    }

    public Task<RecordingRecord?> GetByIdAsync(string recordingId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_byId.TryGetValue(recordingId, out var r) ? r : null);

    public Task<RecordingRecord?> GetByEgressIdAsync(string egressId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_byId.Values.FirstOrDefault(r => string.Equals(r.EgressId, egressId, StringComparison.Ordinal)));

    public Task<RecordingRecord?> GetLatestByCallAsync(Guid callId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_byId.Values.Where(r => r.CallId == callId).OrderByDescending(r => r.CreatedAt).FirstOrDefault());

    public Task<IReadOnlyList<RecordingRecord>> ListByClinicAsync(string clinicId, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<RecordingRecord>>(_byId.Values
            .Where(r => string.Equals(r.ClinicId, clinicId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(r => r.UpdatedAt)
            .ToList());

    public Task<IReadOnlyList<RecordingRecord>> ListStuckAsync(int limit, CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<RecordingRecord>>(_byId.Values
            .Where(r => r.Status is RecordingLedgerStatus.Finalizing or RecordingLedgerStatus.Recording)
            .OrderBy(r => r.FinalizingStartedAt ?? r.CreatedAt)
            .Take(Math.Max(1, limit))
            .ToList());
}

/// <summary>PostgreSQL source of truth for recording catalog + physical objects.</summary>
public sealed class PostgresRecordingCatalog(IConfiguration configuration, ILogger<PostgresRecordingCatalog> logger)
    : IRecordingCatalog
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

    public async Task EnsureSchemaAsync(CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            CREATE TABLE IF NOT EXISTS recordings (
                id                TEXT PRIMARY KEY,
                clinic_id         TEXT NOT NULL,
                call_id           UUID NOT NULL,
                egress_id         TEXT NULL,
                status            TEXT NOT NULL,
                mode              TEXT NOT NULL,
                error             TEXT NULL,
                created_at        TIMESTAMPTZ NOT NULL,
                updated_at        TIMESTAMPTZ NOT NULL,
                completed_at      TIMESTAMPTZ NULL,
                retention_until   TIMESTAMPTZ NULL,
                caller_id         TEXT NULL,
                assigned_staff_id TEXT NULL,
                call_status       TEXT NULL,
                consent_status    TEXT NULL
            );
            ALTER TABLE recordings ADD COLUMN IF NOT EXISTS finalizing_started_at TIMESTAMPTZ NULL;
            ALTER TABLE recordings ADD COLUMN IF NOT EXISTS terminal_seen_at TIMESTAMPTZ NULL;
            ALTER TABLE recordings ADD COLUMN IF NOT EXISTS completion_reason TEXT NULL;
            ALTER TABLE recordings ADD COLUMN IF NOT EXISTS file_name TEXT NULL;

            CREATE INDEX IF NOT EXISTS ix_recordings_clinic_updated
                ON recordings (clinic_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS ix_recordings_call
                ON recordings (call_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS ix_recordings_egress
                ON recordings (egress_id) WHERE egress_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS ix_recordings_status_retention
                ON recordings (status, retention_until);
            CREATE INDEX IF NOT EXISTS ix_recordings_stuck
                ON recordings (status, finalizing_started_at, terminal_seen_at);

            CREATE TABLE IF NOT EXISTS recording_objects (
                id            BIGSERIAL PRIMARY KEY,
                recording_id  TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
                kind          TEXT NOT NULL,
                storage_key   TEXT NOT NULL,
                codec         TEXT NULL,
                bytes         BIGINT NULL,
                duration_ms   BIGINT NULL,
                etag          TEXT NULL,
                created_at    TIMESTAMPTZ NOT NULL,
                ready_at      TIMESTAMPTZ NULL,
                UNIQUE (recording_id, kind)
            );
            CREATE INDEX IF NOT EXISTS ix_recording_objects_key
                ON recording_objects (storage_key);
            """;
        await cmd.ExecuteNonQueryAsync(cancellationToken);
        logger.LogInformation("Recording catalog schema ensured (PostgreSQL).");
    }

    public async Task InsertRequestedAsync(
        string recordingId,
        string clinicId,
        Guid callId,
        string mode,
        string storageKey,
        string objectKind,
        DateTimeOffset? retentionUntil,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        string? fileName = null,
        CancellationToken cancellationToken = default)
    {
        var now = DateTimeOffset.UtcNow;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var tx = await conn.BeginTransactionAsync(cancellationToken);

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT INTO recordings (
                    id, clinic_id, call_id, egress_id, status, mode, error,
                    created_at, updated_at, completed_at, retention_until,
                    caller_id, assigned_staff_id, call_status, consent_status, file_name)
                VALUES (
                    @id, @clinic, @call, NULL, @status, @mode, NULL,
                    @created, @updated, NULL, @retention,
                    @caller, @staff, @callStatus, @consent, @fileName)
                """;
            cmd.Parameters.AddWithValue("id", recordingId);
            cmd.Parameters.AddWithValue("clinic", clinicId);
            cmd.Parameters.AddWithValue("call", callId);
            cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Requested);
            cmd.Parameters.AddWithValue("mode", mode);
            cmd.Parameters.AddWithValue("created", now);
            cmd.Parameters.AddWithValue("updated", now);
            cmd.Parameters.AddWithValue("retention", (object?)retentionUntil ?? DBNull.Value);
            cmd.Parameters.AddWithValue("caller", (object?)callerId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("staff", (object?)assignedStaffId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("callStatus", (object?)callStatus ?? DBNull.Value);
            cmd.Parameters.AddWithValue("consent", (object?)consentStatus ?? DBNull.Value);
            cmd.Parameters.AddWithValue("fileName", (object?)fileName ?? DBNull.Value);
            await cmd.ExecuteNonQueryAsync(cancellationToken);
        }

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT INTO recording_objects (recording_id, kind, storage_key, created_at)
                VALUES (@rid, @kind, @key, @created)
                ON CONFLICT (recording_id, kind) DO UPDATE
                SET storage_key = EXCLUDED.storage_key
                """;
            cmd.Parameters.AddWithValue("rid", recordingId);
            cmd.Parameters.AddWithValue("kind", objectKind);
            cmd.Parameters.AddWithValue("key", storageKey);
            cmd.Parameters.AddWithValue("created", now);
            await cmd.ExecuteNonQueryAsync(cancellationToken);
        }

        await tx.CommitAsync(cancellationToken);
    }

    public async Task<bool> TryMarkRecordingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET egress_id = @egress, status = @status, updated_at = @updated, error = NULL
            WHERE id = @id AND status = @from
            """;
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Recording);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        cmd.Parameters.AddWithValue("from", RecordingLedgerStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    public async Task<bool> TryMarkFinalizingAsync(string recordingId, string egressId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        var now = DateTimeOffset.UtcNow;
        cmd.CommandText = """
            UPDATE recordings
            SET status = @status,
                egress_id = @egress,
                finalizing_started_at = COALESCE(finalizing_started_at, @now),
                updated_at = @now
            WHERE id = @id
              AND status IN (@from1, @from2)
              AND (egress_id IS NULL OR egress_id = @egress)
            """;
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Finalizing);
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("now", now);
        cmd.Parameters.AddWithValue("id", recordingId);
        cmd.Parameters.AddWithValue("from1", RecordingLedgerStatus.Recording);
        cmd.Parameters.AddWithValue("from2", RecordingLedgerStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    public async Task<bool> TryMarkReadyAsync(
        string recordingId,
        string egressId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        string? completionReason = null,
        CancellationToken cancellationToken = default)
    {
        var now = DateTimeOffset.UtcNow;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var tx = await conn.BeginTransactionAsync(cancellationToken);

        int changed;
        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                UPDATE recordings
                SET status = @status,
                    updated_at = @now,
                    completed_at = @now,
                    error = NULL,
                    completion_reason = COALESCE(@reason, completion_reason)
                WHERE id = @id
                  AND egress_id = @egress
                  AND status IN (@s1, @s2, @s3)
                """;
            cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Ready);
            cmd.Parameters.AddWithValue("now", now);
            cmd.Parameters.AddWithValue("reason", (object?)completionReason ?? DBNull.Value);
            cmd.Parameters.AddWithValue("id", recordingId);
            cmd.Parameters.AddWithValue("egress", egressId);
            cmd.Parameters.AddWithValue("s1", RecordingLedgerStatus.Finalizing);
            cmd.Parameters.AddWithValue("s2", RecordingLedgerStatus.Recording);
            cmd.Parameters.AddWithValue("s3", RecordingLedgerStatus.Requested);
            changed = await cmd.ExecuteNonQueryAsync(cancellationToken);
        }

        if (changed == 0)
        {
            await tx.RollbackAsync(cancellationToken);
            return false;
        }

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT INTO recording_objects (recording_id, kind, storage_key, bytes, duration_ms, etag, created_at, ready_at)
                VALUES (@rid, 'Composite', @key, @bytes, @duration, @etag, @created, @ready)
                ON CONFLICT (recording_id, kind) DO UPDATE
                SET storage_key = EXCLUDED.storage_key,
                    bytes = COALESCE(EXCLUDED.bytes, recording_objects.bytes),
                    duration_ms = COALESCE(EXCLUDED.duration_ms, recording_objects.duration_ms),
                    etag = COALESCE(EXCLUDED.etag, recording_objects.etag),
                    ready_at = EXCLUDED.ready_at
                """;
            cmd.Parameters.AddWithValue("rid", recordingId);
            cmd.Parameters.AddWithValue("key", storageKey);
            cmd.Parameters.AddWithValue("bytes", (object?)bytes ?? DBNull.Value);
            cmd.Parameters.AddWithValue("duration", (object?)durationMs ?? DBNull.Value);
            cmd.Parameters.AddWithValue("etag", (object?)etag ?? DBNull.Value);
            cmd.Parameters.AddWithValue("created", now);
            cmd.Parameters.AddWithValue("ready", now);
            await cmd.ExecuteNonQueryAsync(cancellationToken);
        }

        await tx.CommitAsync(cancellationToken);
        return true;
    }

    public async Task<bool> TryMarkFailedAsync(string recordingId, string egressId, string error, CancellationToken cancellationToken = default)
    {
        var msg = error.Length > 2000 ? error[..2000] : error;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        // egress_id match: exact when known; allow NULL row when start fails before accept.
        cmd.CommandText = """
            UPDATE recordings
            SET status = @status, error = @error, updated_at = @updated
            WHERE id = @id
              AND status IN (@s1, @s2, @s3)
              AND (
                    (@egress <> '' AND egress_id = @egress)
                 OR (@egress = '' AND egress_id IS NULL)
              )
            """;
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Failed);
        cmd.Parameters.AddWithValue("error", msg);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        cmd.Parameters.AddWithValue("egress", egressId ?? "");
        cmd.Parameters.AddWithValue("s1", RecordingLedgerStatus.Requested);
        cmd.Parameters.AddWithValue("s2", RecordingLedgerStatus.Recording);
        cmd.Parameters.AddWithValue("s3", RecordingLedgerStatus.Finalizing);
        return await cmd.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    public async Task<bool> TrySetTerminalSeenAsync(string recordingId, string egressId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        // Only set once; do not touch updated_at (timeout must not reset).
        cmd.CommandText = """
            UPDATE recordings
            SET terminal_seen_at = @now
            WHERE id = @id
              AND egress_id = @egress
              AND terminal_seen_at IS NULL
              AND status IN (@s1, @s2, @s3)
            """;
        cmd.Parameters.AddWithValue("now", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("s1", RecordingLedgerStatus.Finalizing);
        cmd.Parameters.AddWithValue("s2", RecordingLedgerStatus.Recording);
        cmd.Parameters.AddWithValue("s3", RecordingLedgerStatus.Requested);
        return await cmd.ExecuteNonQueryAsync(cancellationToken) > 0;
    }

    public async Task MarkDeletedAsync(string recordingId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET status = @status, updated_at = @updated
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Deleted);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task UpdateCallSnapshotAsync(
        string recordingId,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET caller_id = COALESCE(@caller, caller_id),
                assigned_staff_id = COALESCE(@staff, assigned_staff_id),
                call_status = COALESCE(@callStatus, call_status),
                consent_status = COALESCE(@consent, consent_status),
                updated_at = @updated
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("caller", (object?)callerId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("staff", (object?)assignedStaffId ?? DBNull.Value);
        cmd.Parameters.AddWithValue("callStatus", (object?)callStatus ?? DBNull.Value);
        cmd.Parameters.AddWithValue("consent", (object?)consentStatus ?? DBNull.Value);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task SetFileNameAsync(string recordingId, string fileName, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = "UPDATE recordings SET file_name = @fn WHERE id = @id";
        cmd.Parameters.AddWithValue("fn", fileName);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<RecordingRecord?> GetByIdAsync(string recordingId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.id = @id LIMIT 1";
        cmd.Parameters.AddWithValue("id", recordingId);
        return await ReadOneAsync(cmd, cancellationToken);
    }

    public async Task<RecordingRecord?> GetByEgressIdAsync(string egressId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.egress_id = @egress LIMIT 1";
        cmd.Parameters.AddWithValue("egress", egressId);
        return await ReadOneAsync(cmd, cancellationToken);
    }

    public async Task<RecordingRecord?> GetLatestByCallAsync(Guid callId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.call_id = @call ORDER BY r.created_at DESC LIMIT 1";
        cmd.Parameters.AddWithValue("call", callId);
        return await ReadOneAsync(cmd, cancellationToken);
    }

    public async Task<IReadOnlyList<RecordingRecord>> ListByClinicAsync(string clinicId, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.clinic_id = @clinic ORDER BY r.updated_at DESC";
        cmd.Parameters.AddWithValue("clinic", clinicId);
        return await ReadManyAsync(cmd, cancellationToken);
    }

    public async Task<IReadOnlyList<RecordingRecord>> ListStuckAsync(int limit, CancellationToken cancellationToken = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(cancellationToken);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + """
             WHERE r.status IN (@s1, @s2)
             ORDER BY COALESCE(r.finalizing_started_at, r.created_at) ASC
             LIMIT @lim
            """;
        cmd.Parameters.AddWithValue("s1", RecordingLedgerStatus.Finalizing);
        cmd.Parameters.AddWithValue("s2", RecordingLedgerStatus.Recording);
        cmd.Parameters.AddWithValue("lim", Math.Max(1, limit));
        return await ReadManyAsync(cmd, cancellationToken);
    }

    private const string SelectSql = """
        SELECT r.id, r.clinic_id, r.call_id, r.egress_id, r.status, r.mode, r.error,
               r.created_at, r.updated_at, r.completed_at, r.retention_until,
               r.caller_id, r.assigned_staff_id, r.call_status, r.consent_status,
               o.storage_key, o.kind, o.bytes, o.etag, o.duration_ms,
               r.finalizing_started_at, r.terminal_seen_at, r.completion_reason, r.file_name
        FROM recordings r
        LEFT JOIN recording_objects o
          ON o.recording_id = r.id AND o.kind = 'Composite'
        """;

    private static async Task<RecordingRecord?> ReadOneAsync(NpgsqlCommand cmd, CancellationToken ct)
    {
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) return null;
        return Map(reader);
    }

    private static async Task<IReadOnlyList<RecordingRecord>> ReadManyAsync(NpgsqlCommand cmd, CancellationToken ct)
    {
        var list = new List<RecordingRecord>();
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct))
            list.Add(Map(reader));
        return list;
    }

    private static RecordingRecord Map(NpgsqlDataReader reader) => new()
    {
        Id = reader.GetString(0),
        ClinicId = reader.GetString(1),
        CallId = reader.GetGuid(2),
        EgressId = reader.IsDBNull(3) ? null : reader.GetString(3),
        Status = reader.GetString(4),
        Mode = reader.GetString(5),
        Error = reader.IsDBNull(6) ? null : reader.GetString(6),
        CreatedAt = reader.GetFieldValue<DateTimeOffset>(7),
        UpdatedAt = reader.GetFieldValue<DateTimeOffset>(8),
        CompletedAt = reader.IsDBNull(9) ? null : reader.GetFieldValue<DateTimeOffset>(9),
        RetentionUntil = reader.IsDBNull(10) ? null : reader.GetFieldValue<DateTimeOffset>(10),
        CallerId = reader.IsDBNull(11) ? null : reader.GetString(11),
        AssignedStaffId = reader.IsDBNull(12) ? null : reader.GetString(12),
        CallStatus = reader.IsDBNull(13) ? null : reader.GetString(13),
        ConsentStatus = reader.IsDBNull(14) ? null : reader.GetString(14),
        StorageKey = reader.IsDBNull(15) ? null : reader.GetString(15),
        ObjectKind = reader.IsDBNull(16) ? null : reader.GetString(16),
        Bytes = reader.IsDBNull(17) ? null : reader.GetInt64(17),
        Etag = reader.IsDBNull(18) ? null : reader.GetString(18),
        DurationMs = reader.IsDBNull(19) ? null : reader.GetInt64(19),
        FinalizingStartedAt = reader.IsDBNull(20) ? null : reader.GetFieldValue<DateTimeOffset>(20),
        TerminalSeenAt = reader.IsDBNull(21) ? null : reader.GetFieldValue<DateTimeOffset>(21),
        CompletionReason = reader.IsDBNull(22) ? null : reader.GetString(22),
        FileName = reader.IsDBNull(23) ? null : reader.GetString(23)
    };
}

public static class RecordingCatalogFactory
{
    public static IRecordingCatalog Create(IServiceProvider sp)
    {
        var config = sp.GetRequiredService<IConfiguration>();
        var backend = (config["RECORDING_CATALOG"] ?? "auto").Trim().ToLowerInvariant();
        var hasExplicitDb = !string.IsNullOrWhiteSpace(config["RECORDING_DB"])
                            || !string.IsNullOrWhiteSpace(config.GetConnectionString("Recording"))
                            || !string.IsNullOrWhiteSpace(config["POSTGRES_HOST"]);

        if (backend is "postgres" or "pg" || (backend is "auto" && hasExplicitDb))
            return ActivatorUtilities.CreateInstance<PostgresRecordingCatalog>(sp);

        if (backend is "memory" || backend is "auto")
            return ActivatorUtilities.CreateInstance<MemoryRecordingCatalog>(sp);

        return ActivatorUtilities.CreateInstance<PostgresRecordingCatalog>(sp);
    }
}
