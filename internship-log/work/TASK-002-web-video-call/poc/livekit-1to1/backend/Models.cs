namespace LiveKitPoc.Api;

public sealed record TestIdentity(string Id, string TenantId, string DisplayName);

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
    public required string TenantId { get; init; }
    public required string CallerId { get; init; }
    public required string CalleeId { get; init; }
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

    public CallView ToView() => new(
        Id, TenantId, CallerId, CalleeId, RoomName, Status.ToString(),
        CreatedAt, UpdatedAt, AcceptedBy, RecordingStatus, RecordingEgressId,
        RecordingFileName, RecordingStatus == "Complete" && RecordingFileName is not null);
}

public sealed record CallView(
    Guid Id,
    string TenantId,
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
    bool RecordingAvailable);

public sealed record CreateCallRequest(string CalleeId);
public sealed record TokenResponse(string Url, string Token, DateTimeOffset ExpiresAt);
