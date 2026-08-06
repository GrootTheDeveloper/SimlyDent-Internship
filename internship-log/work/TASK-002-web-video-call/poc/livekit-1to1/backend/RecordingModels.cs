namespace LiveKitPoc.Api;

public enum RecordingMode
{
    None = 0,
    AudioOnly = 1,
    Video = 2
}

public enum ConsentStatus
{
    Pending = 0,
    Granted = 1,
    Declined = 2
}

/// <summary>Clinic-level policy — never mutates mid-call snapshots.</summary>
public sealed class RecordingPolicy
{
    public required string ClinicId { get; init; }
    public RecordingMode DefaultMode { get; init; } = RecordingMode.None;
    public IReadOnlyList<RecordingMode> AllowedModes { get; init; } =
        new[] { RecordingMode.None, RecordingMode.AudioOnly, RecordingMode.Video };
    public bool RequireConsent { get; init; } = true;
    public int RetentionDays { get; init; } = 30;
    public string Version { get; init; } = "1";

    public bool IsModeAllowed(RecordingMode mode) =>
        AllowedModes.Any(m => m == mode);

    public RecordingPolicyView ToView() => new(
        ClinicId,
        DefaultMode.ToString(),
        AllowedModes.Select(m => m.ToString()).ToArray(),
        RequireConsent,
        RetentionDays,
        Version);
}

public sealed record RecordingPolicyView(
    string ClinicId,
    string DefaultMode,
    IReadOnlyList<string> AllowedModes,
    bool RequireConsent,
    int RetentionDays,
    string Version);

/// <summary>
/// Actor-aware recording surface. No egress id, path, or storage credentials.
/// </summary>
public sealed record RecordingView(
    string RecordingMode,
    string RecordingStatus,
    string ConsentStatus,
    DateTimeOffset? ConsentGrantedAt,
    string? ConsentActorId,
    string? ConsentPolicyVersion,
    bool CanStart,
    bool CanStop,
    bool CanDownload,
    bool CanDelete);

public sealed record SetRecordingModeRequest(string Mode);
public sealed record SetConsentRequest(string Status);

public sealed record RecordingAuditEvent(
    string Id,
    DateTimeOffset At,
    string ClinicId,
    Guid? CallId,
    string? RecordingId,
    string ActorId,
    string ActorRole,
    string Action,
    string Result,
    string? Detail = null);
