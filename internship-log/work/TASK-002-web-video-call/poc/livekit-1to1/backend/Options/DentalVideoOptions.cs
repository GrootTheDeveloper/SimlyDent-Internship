namespace LiveKitPoc.Api.Options;

/// <summary>
/// Source-aware dental clip encoding + optional background optimization.
/// Bound from env via <see cref="PocOptionsRegistration"/>.
/// </summary>
public sealed class DentalVideoOptions
{
    public static readonly HashSet<string> AllowedOptimizePresets = new(StringComparer.OrdinalIgnoreCase)
    {
        "ultrafast", "superfast", "veryfast", "faster", "fast",
        "medium", "slow", "slower", "veryslow"
    };

    /// <summary>legacy | advanced | source-aware (default source-aware for new clips).</summary>
    public string EncodingMode { get; set; } = "source-aware";

    public int MaxWidth { get; set; } = 1280;
    public int MaxHeight { get; set; } = 720;
    public int MaxFps { get; set; } = 30;
    public int FallbackWidth { get; set; } = 1280;
    public int FallbackHeight { get; set; } = 720;
    public int FallbackFps { get; set; } = 24;

    public int Bitrate360pKbps { get; set; } = 600;
    public int Bitrate480pKbps { get; set; } = 900;
    public int Bitrate540pKbps { get; set; } = 1200;
    public int Bitrate720p20Kbps { get; set; } = 1400;
    public int Bitrate720p30Kbps { get; set; } = 1800;
    public int MinBitrateKbps { get; set; } = 400;
    public int MaxBitrateKbps { get; set; } = 2500;

    /// <summary>Background H.264 CRF optimizer after Original Ready. Default OFF.</summary>
    public bool OptimizeEnabled { get; set; }
    public int OptimizeCrf { get; set; } = 23;
    public string OptimizePreset { get; set; } = "medium";
    /// <summary>Only delete Original after verified Playback. Default false (safe).</summary>
    public bool DeleteOriginalAfterOptimize { get; set; }
    public int OptimizeIntervalSeconds { get; set; } = 30;
    public int OptimizeBatch { get; set; } = 3;
    /// <summary>Per-job FFmpeg wall-clock timeout.</summary>
    public int OptimizeTimeoutSeconds { get; set; } = 180;
    /// <summary>ffprobe per-file timeout.</summary>
    public int ProbeTimeoutSeconds { get; set; } = 15;
    /// <summary>Minimum percent size reduction to promote Playback (0–100).</summary>
    public double MinSavingPercent { get; set; } = 5;
    /// <summary>Skip optimize when Original smaller than this (bytes).</summary>
    public long MinOriginalBytes { get; set; } = 200_000;
    /// <summary>Skip optimize when duration shorter than this (ms). 0 = disabled.</summary>
    public long MinDurationMs { get; set; } = 3_000;
    public int OptimizeMaxAttempts { get; set; } = 5;
    /// <summary>Lease duration while worker holds claim (seconds).</summary>
    public int OptimizeLeaseSeconds { get; set; } = 600;
    /// <summary>Backoff after transient failure (seconds).</summary>
    public int OptimizeRetryBackoffSeconds { get; set; } = 120;

    public bool IsSourceAware =>
        string.Equals(EncodingMode, "source-aware", StringComparison.OrdinalIgnoreCase)
        || string.Equals(EncodingMode, "advanced", StringComparison.OrdinalIgnoreCase);

    public bool IsLegacyPreset =>
        string.Equals(EncodingMode, "legacy", StringComparison.OrdinalIgnoreCase)
        || string.Equals(EncodingMode, "preset", StringComparison.OrdinalIgnoreCase);

    /// <summary>Fail-fast for contradictory / out-of-range config.</summary>
    public void ValidateOrThrow()
    {
        if (MinBitrateKbps <= 0 || MaxBitrateKbps <= 0)
            throw new InvalidOperationException("Dental bitrate min/max must be positive.");
        if (MinBitrateKbps > MaxBitrateKbps)
            throw new InvalidOperationException(
                "DENTAL_MIN_BITRATE_KBPS must be <= DENTAL_MAX_BITRATE_KBPS.");

        if (MaxWidth is < 160 or > 4096)
            throw new InvalidOperationException("DENTAL_MAX_WIDTH must be in 160..4096.");
        if (MaxHeight is < 160 or > 4096)
            throw new InvalidOperationException("DENTAL_MAX_HEIGHT must be in 160..4096.");
        if (MaxFps is < 1 or > 60)
            throw new InvalidOperationException("DENTAL_MAX_FPS must be in 1..60.");

        if (FallbackWidth is < 160 or > 4096 || FallbackHeight is < 160 or > 4096)
            throw new InvalidOperationException("DENTAL_FALLBACK_WIDTH/HEIGHT must be in 160..4096.");
        if (FallbackFps is < 1 or > 60)
            throw new InvalidOperationException("DENTAL_FALLBACK_FPS must be in 1..60.");

        ValidateTier(Bitrate360pKbps, nameof(Bitrate360pKbps));
        ValidateTier(Bitrate480pKbps, nameof(Bitrate480pKbps));
        ValidateTier(Bitrate540pKbps, nameof(Bitrate540pKbps));
        ValidateTier(Bitrate720p20Kbps, nameof(Bitrate720p20Kbps));
        ValidateTier(Bitrate720p30Kbps, nameof(Bitrate720p30Kbps));

        if (OptimizeCrf is < 16 or > 32)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_CRF must be in 16..32.");
        if (!AllowedOptimizePresets.Contains(OptimizePreset.Trim()))
            throw new InvalidOperationException(
                "DENTAL_VIDEO_OPTIMIZE_PRESET must be a valid x264 preset "
                + "(ultrafast..veryslow). Got: " + OptimizePreset);
        if (OptimizeIntervalSeconds < 5)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_INTERVAL_SECONDS must be >= 5.");
        if (OptimizeBatch is < 1 or > 50)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_BATCH must be in 1..50.");
        if (OptimizeTimeoutSeconds is < 30 or > 3600)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_TIMEOUT_SECONDS must be in 30..3600.");
        if (ProbeTimeoutSeconds is < 2 or > 120)
            throw new InvalidOperationException("DENTAL_PROBE_TIMEOUT_SECONDS must be in 2..120.");
        if (MinSavingPercent is < 0 or > 100)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_MIN_SAVING_PERCENT must be in 0..100.");
        if (OptimizeMaxAttempts is < 1 or > 50)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_MAX_ATTEMPTS must be in 1..50.");
        if (OptimizeLeaseSeconds is < 60 or > 7200)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_LEASE_SECONDS must be in 60..7200.");
        if (OptimizeRetryBackoffSeconds is < 10 or > 3600)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_RETRY_BACKOFF_SECONDS must be in 10..3600.");
        if (MinOriginalBytes < 0)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_MIN_ORIGINAL_BYTES must be >= 0.");
        if (MinDurationMs < 0)
            throw new InvalidOperationException("DENTAL_VIDEO_OPTIMIZE_MIN_DURATION_MS must be >= 0.");
    }

    private void ValidateTier(int kbps, string name)
    {
        if (kbps <= 0)
            throw new InvalidOperationException($"{name} must be positive.");
        if (kbps < MinBitrateKbps || kbps > MaxBitrateKbps)
            throw new InvalidOperationException(
                $"{name}={kbps} is outside min/max bitrate [{MinBitrateKbps}..{MaxBitrateKbps}].");
    }
}
