using LiveKitPoc.Api.Options;

namespace LiveKitPoc.Api;

/// <summary>Immutable encoding choice for TrackComposite dental clips.</summary>
public sealed record DentalEncodeProfile(
    int Width,
    int Height,
    int FrameRate,
    int VideoBitrateKbps,
    string Codec,
    string ProfileName,
    int? SourceWidth,
    int? SourceHeight,
    double? SourceFrameRate,
    bool UsedAdvanced)
{
    public string AuditDetail =>
        $"source={Fmt(SourceWidth)}x{Fmt(SourceHeight)}@{SrcFps}; " +
        $"output={Width}x{Height}@{FrameRate}; bitrate={VideoBitrateKbps}; profile={ProfileName}";

    private string SrcFps =>
        SourceFrameRate is > 0 ? SourceFrameRate.Value.ToString("0.##") : "?";

    private static string Fmt(int? v) => v is > 0 ? v.Value.ToString() : "?";
}

/// <summary>
/// Deterministic source-aware profile: no upscale, no fake FPS, preserve orientation.
/// </summary>
public sealed class DentalEncodingProfileSelector(Microsoft.Extensions.Options.IOptions<DentalVideoOptions> options)
{
    private DentalVideoOptions Opt => options.Value;

    public DentalEncodeProfile Select(int? actualWidth, int? actualHeight, double? actualFrameRate)
    {
        var (srcW, srcH) = NormalizeDimensions(actualWidth, actualHeight);
        var srcFps = NormalizeFps(actualFrameRate);

        // Cap product max (longest side rules), never upscale
        var (outW, outH) = FitWithinCap(srcW, srcH, Opt.MaxWidth, Opt.MaxHeight);
        outW = MakeEven(outW);
        outH = MakeEven(outH);

        var outFps = Math.Clamp(srcFps, 1, Opt.MaxFps);
        var bitrate = SelectBitrate(outW, outH, outFps);
        bitrate = Math.Clamp(bitrate, Opt.MinBitrateKbps, Opt.MaxBitrateKbps);

        var tier = ClassifyTier(outW, outH, outFps);
        var name = $"source-aware-{tier}-{outW}x{outH}@{outFps}";

        return new DentalEncodeProfile(
            outW, outH, outFps, bitrate, "H264_MAIN", name,
            actualWidth is > 0 ? actualWidth : null,
            actualHeight is > 0 ? actualHeight : null,
            actualFrameRate is > 0 ? actualFrameRate : null,
            UsedAdvanced: true);
    }

    /// <summary>Legacy fixed 720p30 when feature flag disables source-aware.</summary>
    public DentalEncodeProfile SelectLegacy720p30() =>
        new(1280, 720, 30,
            Math.Clamp(Opt.Bitrate720p30Kbps, Opt.MinBitrateKbps, Opt.MaxBitrateKbps),
            "H264_MAIN", "legacy-H264_720P_30",
            null, null, null, UsedAdvanced: false);

    public (int w, int h) NormalizeDimensions(int? width, int? height)
    {
        var w = width is > 0 and < 8192 ? width.Value : 0;
        var h = height is > 0 and < 8192 ? height.Value : 0;
        if (w <= 0 || h <= 0)
            return (MakeEven(Opt.FallbackWidth), MakeEven(Opt.FallbackHeight));
        return (w, h);
    }

    public int NormalizeFps(double? fps)
    {
        if (fps is null || double.IsNaN(fps.Value) || double.IsInfinity(fps.Value) || fps.Value <= 0)
            return Math.Clamp(Opt.FallbackFps, 1, 60);
        // Round 29.97 → 30, 23.976 → 24, etc.
        var rounded = (int)Math.Round(fps.Value, MidpointRounding.AwayFromZero);
        return Math.Clamp(rounded, 1, 60);
    }

    /// <summary>
    /// Scale down so both sides fit max box; never scale up; preserve aspect + orientation.
    /// maxW×maxH is landscape product box (e.g. 1280×720). Portrait uses swapped bounds.
    /// </summary>
    public static (int w, int h) FitWithinCap(int srcW, int srcH, int maxW, int maxH)
    {
        if (srcW <= 0 || srcH <= 0) return (MakeEven(maxW), MakeEven(maxH));

        int boxW, boxH;
        if (srcH > srcW)
        {
            // Portrait: short side ≤ min(maxW,maxH), long side ≤ max(maxW,maxH)
            boxW = Math.Min(maxW, maxH);
            boxH = Math.Max(maxW, maxH);
        }
        else
        {
            boxW = maxW;
            boxH = maxH;
        }

        var scale = Math.Min(1.0, Math.Min((double)boxW / srcW, (double)boxH / srcH));
        var outW = Math.Max(2, (int)Math.Floor(srcW * scale));
        var outH = Math.Max(2, (int)Math.Floor(srcH * scale));
        return (outW, outH);
    }

    public static int MakeEven(int v)
    {
        if (v < 2) return 2;
        return v % 2 == 0 ? v : v - 1;
    }

    public int SelectBitrate(int width, int height, int fps)
    {
        var longSide = Math.Max(width, height);
        var pixels = width * height;
        var p480 = 640 * 480;

        // Conservative tiers: do not drop 720p30 target (1800) in this change.
        if (longSide <= 360)
            return Opt.Bitrate360pKbps;
        if (longSide <= 480 || pixels <= p480 * 1.1)
            return Opt.Bitrate480pKbps;
        if (longSide <= 540)
            return Opt.Bitrate540pKbps;
        if (fps <= 20)
            return Opt.Bitrate720p20Kbps;
        return Opt.Bitrate720p30Kbps;
    }

    private static string ClassifyTier(int w, int h, int fps)
    {
        var longSide = Math.Max(w, h);
        var pixels = w * h;
        if (longSide <= 360) return "360p";
        if (longSide <= 480 || pixels <= 640 * 480 * 1.1) return "480p";
        if (longSide <= 540) return "540p";
        if (fps <= 20) return "720p20";
        return "720p30";
    }
}
