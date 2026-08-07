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

    public static string FromUiStatus(string uiStatus) => uiStatus switch
    {
        "Starting" => Requested,
        "Recording" => Recording,
        "Stopping" => Finalizing,
        "Complete" => Ready,
        "Deleted" => Deleted,
        "Failed" => Failed,
        _ => uiStatus
    };

    public static bool IsDownloadable(string ledgerStatus) =>
        ledgerStatus is Ready;

    public static bool IsActive(string ledgerStatus) =>
        ledgerStatus is Requested or Recording or Finalizing;
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
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
    public DateTimeOffset? RetentionUntil { get; init; }
    public string? CallerId { get; init; }
    public string? AssignedStaffId { get; init; }
    public string? CallStatus { get; init; }
    public string? ConsentStatus { get; init; }

    /// <summary>Primary composite object key when present.</summary>
    public string? StorageKey { get; init; }
    public string? ObjectKind { get; init; }
    public long? Bytes { get; init; }
    public string? Etag { get; init; }
    public long? DurationMs { get; init; }
}

public interface IRecordingCatalog
{
    string BackendName { get; }

    Task EnsureSchemaAsync(CancellationToken ct = default);

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
        CancellationToken ct = default);

    Task MarkRecordingAsync(string recordingId, string egressId, CancellationToken ct = default);

    Task MarkFinalizingAsync(string recordingId, CancellationToken ct = default);

    Task MarkReadyAsync(
        string recordingId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        CancellationToken ct = default);

    Task MarkFailedAsync(string recordingId, string error, CancellationToken ct = default);

    Task MarkDeletedAsync(string recordingId, CancellationToken ct = default);

    Task UpdateCallSnapshotAsync(
        string recordingId,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        CancellationToken ct = default);

    Task<RecordingRecord?> GetByIdAsync(string recordingId, CancellationToken ct = default);

    Task<RecordingRecord?> GetByEgressIdAsync(string egressId, CancellationToken ct = default);

    Task<RecordingRecord?> GetLatestByCallAsync(Guid callId, CancellationToken ct = default);

    Task<IReadOnlyList<RecordingRecord>> ListByClinicAsync(string clinicId, CancellationToken ct = default);
}

/// <summary>In-process fallback when RECORDING_DB is unset (lab only).</summary>
public sealed class MemoryRecordingCatalog : IRecordingCatalog
{
    private readonly ConcurrentDictionary<string, RecordingRecord> _byId = new(StringComparer.Ordinal);
    private readonly object _gate = new();

    public string BackendName => "memory";

    public Task EnsureSchemaAsync(CancellationToken ct = default) => Task.CompletedTask;

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
        CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        var rec = new RecordingRecord
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
            ObjectKind = objectKind
        };
        _byId[recordingId] = rec;
        return Task.CompletedTask;
    }

    public Task MarkRecordingAsync(string recordingId, string egressId, CancellationToken ct = default)
    {
        Mutate(recordingId, r => r with
        {
            EgressId = egressId,
            Status = RecordingLedgerStatus.Recording,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        return Task.CompletedTask;
    }

    public Task MarkFinalizingAsync(string recordingId, CancellationToken ct = default)
    {
        Mutate(recordingId, r => r with
        {
            Status = RecordingLedgerStatus.Finalizing,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        return Task.CompletedTask;
    }

    public Task MarkReadyAsync(
        string recordingId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        Mutate(recordingId, r => r with
        {
            Status = RecordingLedgerStatus.Ready,
            StorageKey = storageKey,
            Bytes = bytes ?? r.Bytes,
            Etag = etag ?? r.Etag,
            DurationMs = durationMs ?? r.DurationMs,
            CompletedAt = now,
            UpdatedAt = now
        });
        return Task.CompletedTask;
    }

    public Task MarkFailedAsync(string recordingId, string error, CancellationToken ct = default)
    {
        Mutate(recordingId, r => r with
        {
            Status = RecordingLedgerStatus.Failed,
            Error = error.Length > 2000 ? error[..2000] : error,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        return Task.CompletedTask;
    }

    public Task MarkDeletedAsync(string recordingId, CancellationToken ct = default)
    {
        Mutate(recordingId, r => r with
        {
            Status = RecordingLedgerStatus.Deleted,
            StorageKey = null,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        return Task.CompletedTask;
    }

    public Task UpdateCallSnapshotAsync(
        string recordingId,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        CancellationToken ct = default)
    {
        Mutate(recordingId, r => r with
        {
            CallerId = callerId ?? r.CallerId,
            AssignedStaffId = assignedStaffId ?? r.AssignedStaffId,
            CallStatus = callStatus ?? r.CallStatus,
            ConsentStatus = consentStatus ?? r.ConsentStatus,
            UpdatedAt = DateTimeOffset.UtcNow
        });
        return Task.CompletedTask;
    }

    public Task<RecordingRecord?> GetByIdAsync(string recordingId, CancellationToken ct = default) =>
        Task.FromResult(_byId.TryGetValue(recordingId, out var r) ? r : null);

    public Task<RecordingRecord?> GetByEgressIdAsync(string egressId, CancellationToken ct = default)
    {
        var hit = _byId.Values.FirstOrDefault(r =>
            string.Equals(r.EgressId, egressId, StringComparison.Ordinal));
        return Task.FromResult(hit);
    }

    public Task<RecordingRecord?> GetLatestByCallAsync(Guid callId, CancellationToken ct = default)
    {
        var hit = _byId.Values
            .Where(r => r.CallId == callId)
            .OrderByDescending(r => r.CreatedAt)
            .FirstOrDefault();
        return Task.FromResult(hit);
    }

    public Task<IReadOnlyList<RecordingRecord>> ListByClinicAsync(string clinicId, CancellationToken ct = default)
    {
        IReadOnlyList<RecordingRecord> list = _byId.Values
            .Where(r => string.Equals(r.ClinicId, clinicId, StringComparison.OrdinalIgnoreCase))
            .OrderByDescending(r => r.UpdatedAt)
            .ToList();
        return Task.FromResult(list);
    }

    private void Mutate(string recordingId, Func<RecordingRecord, RecordingRecord> map)
    {
        lock (_gate)
        {
            if (!_byId.TryGetValue(recordingId, out var existing))
                return;
            _byId[recordingId] = map(existing);
        }
    }
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

    public async Task EnsureSchemaAsync(CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
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
            CREATE INDEX IF NOT EXISTS ix_recordings_clinic_updated
                ON recordings (clinic_id, updated_at DESC);
            CREATE INDEX IF NOT EXISTS ix_recordings_call
                ON recordings (call_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS ix_recordings_egress
                ON recordings (egress_id) WHERE egress_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS ix_recordings_status_retention
                ON recordings (status, retention_until);

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
        await cmd.ExecuteNonQueryAsync(ct);
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
        CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                INSERT INTO recordings (
                    id, clinic_id, call_id, egress_id, status, mode, error,
                    created_at, updated_at, completed_at, retention_until,
                    caller_id, assigned_staff_id, call_status, consent_status)
                VALUES (
                    @id, @clinic, @call, NULL, @status, @mode, NULL,
                    @created, @updated, NULL, @retention,
                    @caller, @staff, @callStatus, @consent)
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
            await cmd.ExecuteNonQueryAsync(ct);
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
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);
    }

    public async Task MarkRecordingAsync(string recordingId, string egressId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET egress_id = @egress, status = @status, updated_at = @updated, error = NULL
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("egress", egressId);
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Recording);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task MarkFinalizingAsync(string recordingId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET status = @status, updated_at = @updated
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Finalizing);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task MarkReadyAsync(
        string recordingId,
        string storageKey,
        long? bytes = null,
        string? etag = null,
        long? durationMs = null,
        CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);

        await using (var cmd = conn.CreateCommand())
        {
            cmd.Transaction = tx;
            cmd.CommandText = """
                UPDATE recordings
                SET status = @status, updated_at = @updated, completed_at = @completed, error = NULL
                WHERE id = @id
                """;
            cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Ready);
            cmd.Parameters.AddWithValue("updated", now);
            cmd.Parameters.AddWithValue("completed", now);
            cmd.Parameters.AddWithValue("id", recordingId);
            await cmd.ExecuteNonQueryAsync(ct);
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
            await cmd.ExecuteNonQueryAsync(ct);
        }

        await tx.CommitAsync(ct);
    }

    public async Task MarkFailedAsync(string recordingId, string error, CancellationToken ct = default)
    {
        var msg = error.Length > 2000 ? error[..2000] : error;
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET status = @status, error = @error, updated_at = @updated
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Failed);
        cmd.Parameters.AddWithValue("error", msg);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task MarkDeletedAsync(string recordingId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            UPDATE recordings
            SET status = @status, updated_at = @updated
            WHERE id = @id
            """;
        cmd.Parameters.AddWithValue("status", RecordingLedgerStatus.Deleted);
        cmd.Parameters.AddWithValue("updated", DateTimeOffset.UtcNow);
        cmd.Parameters.AddWithValue("id", recordingId);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task UpdateCallSnapshotAsync(
        string recordingId,
        string? callerId,
        string? assignedStaffId,
        string? callStatus,
        string? consentStatus,
        CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
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
        await cmd.ExecuteNonQueryAsync(ct);
    }

    public async Task<RecordingRecord?> GetByIdAsync(string recordingId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.id = @id LIMIT 1";
        cmd.Parameters.AddWithValue("id", recordingId);
        return await ReadOneAsync(cmd, ct);
    }

    public async Task<RecordingRecord?> GetByEgressIdAsync(string egressId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.egress_id = @egress LIMIT 1";
        cmd.Parameters.AddWithValue("egress", egressId);
        return await ReadOneAsync(cmd, ct);
    }

    public async Task<RecordingRecord?> GetLatestByCallAsync(Guid callId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.call_id = @call ORDER BY r.created_at DESC LIMIT 1";
        cmd.Parameters.AddWithValue("call", callId);
        return await ReadOneAsync(cmd, ct);
    }

    public async Task<IReadOnlyList<RecordingRecord>> ListByClinicAsync(string clinicId, CancellationToken ct = default)
    {
        await using var conn = new NpgsqlConnection(_connectionString);
        await conn.OpenAsync(ct);
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = SelectSql + " WHERE r.clinic_id = @clinic ORDER BY r.updated_at DESC";
        cmd.Parameters.AddWithValue("clinic", clinicId);
        return await ReadManyAsync(cmd, ct);
    }

    private const string SelectSql = """
        SELECT r.id, r.clinic_id, r.call_id, r.egress_id, r.status, r.mode, r.error,
               r.created_at, r.updated_at, r.completed_at, r.retention_until,
               r.caller_id, r.assigned_staff_id, r.call_status, r.consent_status,
               o.storage_key, o.kind, o.bytes, o.etag, o.duration_ms
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
        DurationMs = reader.IsDBNull(19) ? null : reader.GetInt64(19)
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

        // auto without postgres config → memory (local lab)
        if (backend is "memory" || backend is "auto")
            return ActivatorUtilities.CreateInstance<MemoryRecordingCatalog>(sp);

        return ActivatorUtilities.CreateInstance<PostgresRecordingCatalog>(sp);
    }
}
