namespace LiveKitPoc.Api;

/// <summary>
/// Server-owned staff/visitor identity. ClinicId is authoritative for multi-clinic isolation.
/// Demo staff: A1/A2/A3 → clinic-a; B1 → clinic-b.
/// Demo visitors (Phase 1 queue): VA → clinic-a; VB → clinic-b.
/// </summary>
public sealed record TestIdentity(
    string Id,
    string ClinicId,
    string DisplayName,
    string Role = IdentityRoles.Staff);

public static class IdentityRoles
{
    public const string Staff = "Staff";
    public const string Visitor = "Visitor";
}

public enum CallStatus
{
    /// <summary>Waiting in clinic FIFO queue for an Available agent.</summary>
    Queued,
    Ringing,
    Accepted,
    Rejected,
    Cancelled,
    Ended,
    /// <summary>No agent became available before visitor timeout.</summary>
    NoAgent,
    /// <summary>Visitor waited longer than visitor_timeout.</summary>
    Timeout,
    /// <summary>Outside working hours (Phase 1 stub — not enqueued).</summary>
    Closed
}

public enum CallOrigin
{
    /// <summary>Classic staff→staff 1:1 (TASK-002 path).</summary>
    Direct,
    /// <summary>Visitor (or enqueue API) → clinic queue → auto-dispatch.</summary>
    Queue
}

public sealed class CallSession
{
    public required Guid Id { get; init; }
    /// <summary>Server-assigned clinic that owns this call. Never taken from the client.</summary>
    public required string ClinicId { get; init; }
    public required string CallerId { get; init; }
    /// <summary>
    /// For Direct: fixed callee. For Queue: current assigned staff (empty while Queued).
    /// </summary>
    public string CalleeId { get; set; } = "";
    public CallOrigin Origin { get; init; } = CallOrigin.Direct;
    /// <summary>Staff currently reserved/assigned (Ringing or InCall). Null when Queued.</summary>
    public string? AssignedStaffId { get; set; }
    /// <summary>Backend-generated LiveKit room: clinic:{{clinicId}}:call:{{callId}}.</summary>
    public required string RoomName { get; init; }
    public CallStatus Status { get; set; } = CallStatus.Ringing;
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? RingingStartedAt { get; set; }
    /// <summary>Updated by embed poll (Phase 2); also usable for demo queue visitors.</summary>
    public DateTimeOffset? VisitorLastSeenAt { get; set; }
    public string? AcceptedBy { get; set; }
    /// <summary>Staff already tried for this queue call (avoid immediate re-ring same agent).</summary>
    public HashSet<string> TriedStaffIds { get; } = new(StringComparer.OrdinalIgnoreCase);
    public string RecordingStatus { get; set; } = "Idle";
    public string? RecordingEgressId { get; set; }
    public string? RecordingFileName { get; set; }
    public object SyncRoot { get; } = new();

    public bool Contains(string userId)
    {
        if (string.Equals(CallerId, userId, StringComparison.OrdinalIgnoreCase)) return true;
        if (!string.IsNullOrEmpty(CalleeId) &&
            string.Equals(CalleeId, userId, StringComparison.OrdinalIgnoreCase)) return true;
        if (!string.IsNullOrEmpty(AssignedStaffId) &&
            string.Equals(AssignedStaffId, userId, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    /// <summary>Call still occupies capacity (queue wait, ring, or media).</summary>
    public bool IsActive => Status is CallStatus.Queued or CallStatus.Ringing or CallStatus.Accepted;

    public bool BelongsToClinic(string clinicId) =>
        string.Equals(ClinicId, clinicId, StringComparison.OrdinalIgnoreCase);

    public CallView ToView() => new(
        Id, ClinicId, CallerId, CalleeId, RoomName, Status.ToString(),
        CreatedAt, UpdatedAt, AcceptedBy, RecordingStatus, RecordingEgressId,
        RecordingFileName, RecordingStatus == "Complete" && RecordingFileName is not null,
        Origin.ToString(), AssignedStaffId);

    /// <summary>
    /// Deterministic clinic-scoped LiveKit room name.
    /// Format: clinic:{clinicId}:call:{callId:N}
    /// </summary>
    public static string BuildRoomName(string clinicId, Guid callId) =>
        $"clinic:{SanitizeSegment(clinicId)}:call:{callId:N}";

    private static string SanitizeSegment(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ArgumentException("Clinic id is required for room naming.", nameof(value));
        var chars = value.Trim().Select(ch =>
            char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '-').ToArray();
        return new string(chars).ToLowerInvariant();
    }
}

/// <summary>
/// API view of a call. ClinicId is canonical; TenantId is a compatibility alias (same value).
/// </summary>
public sealed record CallView(
    Guid Id,
    string ClinicId,
    string CallerId,
    string CalleeId,
    string RoomName,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    string? AcceptedBy,
    string RecordingStatus,
    string? RecordingEgressId,
    string? RecordingFileName,
    bool RecordingAvailable,
    string Origin = "Direct",
    string? AssignedStaffId = null)
{
    /// <summary>Deprecated alias of ClinicId for older clients / scripts.</summary>
    public string TenantId => ClinicId;
}

public sealed record CreateCallRequest(string CalleeId);
public sealed record TokenResponse(string Url, string Token, DateTimeOffset ExpiresAt);

// Login DTOs live in Program.cs as file-scoped records for the auth endpoints.
