namespace LiveKitPoc.Api;

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
    IReadOnlyList<MediaAssetDetailView> VideoClips,
    IReadOnlyList<MediaAssetDetailView> Photos);

public sealed record MediaAssetDetailView(
    Guid AssetId, string Kind, string Status,
    int DisplayIndex,
    DateTimeOffset? StartedAt, DateTimeOffset? EndedAt, DateTimeOffset? CapturedAt,
    long? DurationMs, long? Bytes, int? Width, int? Height, string? MimeType,
    string? Label, string? Note, string? Error,
    bool CanDownload, bool CanMarkDelete);

public sealed record MediaStateView(
    Guid CallId,
    string AutoAudioStatus,
    string ActiveDentalClipStatus,
    Guid? ActiveDentalClipAssetId,
    IReadOnlyList<MediaAssetDetailView> Assets);

/// <summary>JSON body for POST video-clips/start — class for reliable minimal-API binding.</summary>
public sealed class StartDentalClipRequest
{
    public string PatientParticipantIdentity { get; set; } = "";
    public string? PatientVideoTrackSidHint { get; set; }
    /// <summary>Browser getSettings() may send floats (e.g. 1280.0); accept number then round.</summary>
    public double? ActualWidth { get; set; }
    public double? ActualHeight { get; set; }
    /// <summary>Often 29.97 / 30.00003 from MediaTrackSettings — must not be int? or STJ throws.</summary>
    public double? ActualFrameRate { get; set; }

    public int? WidthPx => ActualWidth is > 0 ? (int)Math.Round(ActualWidth.Value) : null;
    public int? HeightPx => ActualHeight is > 0 ? (int)Math.Round(ActualHeight.Value) : null;
}

public sealed class RequestPhotoBody
{
    public string PatientParticipantIdentity { get; set; } = "";
}

public sealed record UploadCompleteBody(
    int? ActualWidth = null,
    int? ActualHeight = null,
    long? Bytes = null);
