namespace LiveKitPoc.Api.Options;

/// <summary>
/// Source-aware dental clip encoding + optional background optimization.
/// Bound from env via <see cref="PocOptionsRegistration"/>.
/// </summary>
public sealed class DentalVideoOptions
{
    /// <summary>legacy | advanced | source-aware (default source-aware for new clips).</summary>
    public string EncodingMode { get; set; } = "source-aware";

    public int MaxWidth { get; set; } = 1280;
    public int MaxHeight { get; set; } = 720;
    public int MaxFps { get; set; } = 30;
    public int FallbackWidth { get; set; } = 1280;
    public int FallbackHeight { get; set; } = 720;
    public int FallbackFps { get; set; } = 24;

    public int Bitrate480pKbps { get; set; } = 900;
    public int Bitrate720p20Kbps { get; set; } = 1400;
    public int Bitrate720p30Kbps { get; set; } = 1800;
    public int MinBitrateKbps { get; set; } = 400;
    public int MaxBitrateKbps { get; set; } = 2500;

    /// <summary>Background H.264 CRF optimizer after Original Ready.</summary>
    public bool OptimizeEnabled { get; set; }
    public int OptimizeCrf { get; set; } = 23;
    public string OptimizePreset { get; set; } = "medium";
    public bool DeleteOriginalAfterOptimize { get; set; }
    public int OptimizeIntervalSeconds { get; set; } = 30;
    public int OptimizeBatch { get; set; } = 3;

    public bool IsSourceAware =>
        string.Equals(EncodingMode, "source-aware", StringComparison.OrdinalIgnoreCase)
        || string.Equals(EncodingMode, "advanced", StringComparison.OrdinalIgnoreCase);

    public bool IsLegacyPreset =>
        string.Equals(EncodingMode, "legacy", StringComparison.OrdinalIgnoreCase)
        || string.Equals(EncodingMode, "preset", StringComparison.OrdinalIgnoreCase);
}
