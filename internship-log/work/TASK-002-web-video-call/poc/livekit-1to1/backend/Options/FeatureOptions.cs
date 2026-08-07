namespace LiveKitPoc.Api.Options;

/// <summary>Feature flags (flat env FEATURE_*).</summary>
public sealed class FeatureOptions
{
    public const string SectionName = "Features";

    /// <summary>
    /// When false, skip auto CallAudio room-composite (lab 2 vCPU workaround).
    /// Env: FEATURE_AUTO_CALL_AUDIO=0|false|off
    /// </summary>
    public bool AutoCallAudio { get; set; } = true;
}
