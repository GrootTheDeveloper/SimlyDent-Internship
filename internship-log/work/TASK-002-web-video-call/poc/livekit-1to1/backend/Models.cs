namespace LiveKitPoc.Api;

/// <summary>
/// Server-owned staff/visitor/manager identity. ClinicId is authoritative for multi-clinic isolation.
/// Demo staff: A1/A2/A3 → clinic-a; B1 → clinic-b.
/// Demo managers: A-MGR → clinic-a; B-MGR → clinic-b (not auto-dispatched).
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
    public const string Manager = "Manager";
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
    /// <summary>
    /// Bumped on every assignment / release so Reject/timeout cannot act on a stale reservation
    /// after redispatch assigned a different staff (or the same staff a new epoch later).
    /// </summary>
    public int AssignmentEpoch { get; set; }
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

    // ---- Recording snapshot (independent of live clinic policy after set) ----
    public RecordingMode RecordingMode { get; set; } = RecordingMode.None;
    public ConsentStatus ConsentStatus { get; set; } = ConsentStatus.Pending;
    public DateTimeOffset? ConsentGrantedAt { get; set; }
    public string? ConsentActorId { get; set; }
    public string? ConsentPolicyVersion { get; set; }
    /// <summary>Idle | Starting | Recording | Stopping | Complete | Failed | Deleted</summary>
    public string RecordingStatus { get; set; } = "Idle";
    /// <summary>Internal — never on public CallView.</summary>
    public string? RecordingEgressId { get; set; }
    /// <summary>Internal storage key (clinic-scoped). Not absolute client path.</summary>
    public string? RecordingStorageKey { get; set; }
    /// <summary>Legacy egress local basename while finalizing; not exposed on CallView.</summary>
    public string? RecordingFileName { get; set; }
    public string? RecordingId { get; set; }

    // ---- Consultation media domain (UI cache; catalog is source of truth after restart) ----
    public Guid? ConsultationSessionId { get; set; }
    public Guid? ActiveDentalClipAssetId { get; set; }
    /// <summary>Idle | Recording | Finalizing</summary>
    public string ActiveDentalClipStatus { get; set; } = "Idle";
    /// <summary>Idle | Recording | Finalizing | Ready | Failed</summary>
    public string AutoAudioStatus { get; set; } = "Idle";

    /// <summary>
    /// Authoritative initial realtime media for this call: Audio | Video.
    /// Set once at creation; both participants derive camera on/off from this — not from URL/query alone.
    /// Runtime camera toggles do not change this value.
    /// </summary>
    public string InitialMediaMode { get; set; } = "Video";

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

    /// <summary>
    /// Public call DTO — business recording fields only (no egress id / storage path).
    /// </summary>
    public CallView ToView() => new(
        Id, ClinicId, CallerId, CalleeId, RoomName, Status.ToString(),
        CreatedAt, UpdatedAt, AcceptedBy,
        RecordingMode.ToString(),
        RecordingStatus,
        ConsentStatus.ToString(),
        RecordingStatus == "Complete" && !string.IsNullOrWhiteSpace(RecordingStorageKey),
        Origin.ToString(), AssignedStaffId,
        NormalizeMediaMode(InitialMediaMode),
        AutoAudioStatus);

    /// <summary>Normalize client/server media mode strings to Audio | Video.</summary>
    public static string NormalizeMediaMode(string? mode) =>
        string.Equals(mode, "Audio", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(mode, "audio", StringComparison.OrdinalIgnoreCase)
            ? "Audio"
            : "Video";

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
/// Recording internals (egress id, file path) are never included.
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
    string RecordingMode,
    string RecordingStatus,
    string ConsentStatus,
    bool RecordingAvailable,
    string Origin = "Direct",
    string? AssignedStaffId = null,
    string InitialMediaMode = "Video",
    /// <summary>Idle | Recording | Finalizing | Ready | Failed — auto CallAudio (product always-on).</summary>
    string AutoAudioStatus = "Idle")
{
    /// <summary>Deprecated alias of ClinicId for older clients / scripts.</summary>
    public string TenantId => ClinicId;
}

public sealed record CreateCallRequest(string CalleeId, string? InitialMediaMode = null);
public sealed record CreateQueueCallRequest(string? InitialMediaMode = null);
public sealed record TokenResponse(string Url, string Token, DateTimeOffset ExpiresAt);

/// <summary>
/// Public embed poll DTO — intentionally smaller than <see cref="CallView"/>.
/// No roomName, recording internals, egress, or staff assignment fields.
/// Room is only present inside the short-lived LiveKit JWT after Accept.
/// </summary>
public sealed record EmbedCallView(
    Guid Id,
    string Status,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt,
    int WaitingSeconds,
    string RecordingMode = "None",
    string RecordingStatus = "Idle",
    string ConsentStatus = "Pending",
    /// <summary>Audio | Video — join preference set at enqueue (not runtime session mode).</summary>
    string InitialMediaMode = "Video")
{
    public static EmbedCallView From(CallSession call)
    {
        var waiting = Math.Max(0, (int)(DateTimeOffset.UtcNow - call.CreatedAt).TotalSeconds);
        return new EmbedCallView(
            call.Id,
            call.Status.ToString(),
            call.CreatedAt,
            call.UpdatedAt,
            waiting,
            call.RecordingMode.ToString(),
            call.RecordingStatus,
            call.ConsentStatus.ToString(),
            CallSession.NormalizeMediaMode(call.InitialMediaMode));
    }
}

/// <summary>
/// Unified actor for cancel/end/ownership checks.
/// Staff comes from IdentityRegistry; embed visitors from EmbedSession claims (no registry row).
/// </summary>
public sealed record CallActor(string Id, string ClinicId, string Role, string DisplayName = "")
{
    public bool IsStaff =>
        string.Equals(Role, IdentityRoles.Staff, StringComparison.OrdinalIgnoreCase);

    public bool IsManager =>
        string.Equals(Role, IdentityRoles.Manager, StringComparison.OrdinalIgnoreCase);

    public bool IsVisitor =>
        string.Equals(Role, IdentityRoles.Visitor, StringComparison.OrdinalIgnoreCase);

    public TestIdentity AsIdentity() =>
        new(Id, ClinicId, string.IsNullOrWhiteSpace(DisplayName) ? Id : DisplayName, Role);

    public static CallActor FromStaff(TestIdentity staff) =>
        new(staff.Id, staff.ClinicId, staff.Role, staff.DisplayName);

    public static CallActor FromEmbed(EmbedSession session) =>
        new(session.VisitorId, session.ClinicId, IdentityRoles.Visitor, "Visitor");
}

// Login DTOs live in Program.cs as file-scoped records for the auth endpoints.
