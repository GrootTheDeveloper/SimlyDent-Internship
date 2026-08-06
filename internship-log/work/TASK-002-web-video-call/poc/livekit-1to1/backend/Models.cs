namespace LiveKitPoc.Api;

/// <summary>
/// Server-owned staff identity. ClinicId is authoritative for multi-clinic isolation.
/// Demo ids A1/A2/A3 → clinic-a; B1 → clinic-b.
/// </summary>
public sealed record TestIdentity(string Id, string ClinicId, string DisplayName);

public enum CallStatus
{
    Ringing,
    Accepted,
    Rejected,
    Cancelled,
    Ended
}

public sealed class CallSession
{
    public required Guid Id { get; init; }
    /// <summary>Server-assigned clinic that owns this call. Never taken from the client.</summary>
    public required string ClinicId { get; init; }
    public required string CallerId { get; init; }
    public required string CalleeId { get; init; }
    /// <summary>Backend-generated LiveKit room: clinic:{{clinicId}}:call:{{callId}}.</summary>
    public required string RoomName { get; init; }
    public CallStatus Status { get; set; } = CallStatus.Ringing;
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public string? AcceptedBy { get; set; }
    public string RecordingStatus { get; set; } = "Idle";
    public string? RecordingEgressId { get; set; }
    public string? RecordingFileName { get; set; }
    public object SyncRoot { get; } = new();

    public bool Contains(string userId) => CallerId == userId || CalleeId == userId;
    public bool IsActive => Status is CallStatus.Ringing or CallStatus.Accepted;

    public bool BelongsToClinic(string clinicId) =>
        string.Equals(ClinicId, clinicId, StringComparison.OrdinalIgnoreCase);

    public CallView ToView() => new(
        Id, ClinicId, CallerId, CalleeId, RoomName, Status.ToString(),
        CreatedAt, UpdatedAt, AcceptedBy, RecordingStatus, RecordingEgressId,
        RecordingFileName, RecordingStatus == "Complete" && RecordingFileName is not null);

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
        // Keep alphanumerics, dash, underscore; map other chars to hyphen for LiveKit-safe names.
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
    bool RecordingAvailable)
{
    /// <summary>Deprecated alias of ClinicId for older clients / scripts.</summary>
    public string TenantId => ClinicId;
}

public sealed record CreateCallRequest(string CalleeId);
public sealed record TokenResponse(string Url, string Token, DateTimeOffset ExpiresAt);

// Login DTOs live in Program.cs as file-scoped records for the auth endpoints.
