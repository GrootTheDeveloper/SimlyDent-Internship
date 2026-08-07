namespace LiveKitPoc.Api.Options;

/// <summary>Recording / finalize / reconcile runtime knobs.</summary>
public sealed class RecordingRuntimeOptions
{
    public const string SectionName = "Recording";

    public string RecordingsPath { get; set; } = "/recordings";
    /// <summary>local | s3 | minio</summary>
    public string EgressOutput { get; set; } = "local";
    public int FinalizeTimeoutSeconds { get; set; } = 300;
    public int ReconcileSeconds { get; set; } = 30;
    public int ReconcileBatch { get; set; } = 40;
    public int ReconcileGraceSeconds { get; set; } = 10;
    public int RetentionDays { get; set; } = 30;
}
