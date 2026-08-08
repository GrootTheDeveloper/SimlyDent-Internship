using Microsoft.Extensions.Options;

namespace LiveKitPoc.Api.Options;

/// <summary>
/// Bind flat env/config keys into typed options and fail-fast on critical missing secrets.
/// </summary>
public static class PocOptionsRegistration
{
    public static IServiceCollection AddPocOptions(this IServiceCollection services, IConfiguration configuration)
    {
        services.Configure<LiveKitOptions>(o =>
        {
            o.HttpUrl = configuration["LIVEKIT_HTTP_URL"] ?? o.HttpUrl;
            o.ApiKey = configuration["LIVEKIT_API_KEY"] ?? o.ApiKey;
            o.ApiSecret = configuration["LIVEKIT_API_SECRET"] ?? o.ApiSecret;
        });

        services.Configure<AuthOptions>(o =>
        {
            o.JwtSecret = configuration["JWT_SECRET"]
                ?? configuration["AUTH_JWT_SECRET"]
                ?? o.JwtSecret;
            o.JwtIssuer = configuration["JWT_ISSUER"] ?? o.JwtIssuer;
            o.JwtAudience = configuration["JWT_AUDIENCE"] ?? o.JwtAudience;
            if (int.TryParse(configuration["JWT_LIFETIME_MINUTES"], out var m) && m > 0)
                o.JwtLifetimeMinutes = m;
            o.RequireStrictSecrets =
                string.Equals(configuration["REQUIRE_STRICT_SECRETS"], "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(configuration["REQUIRE_STRICT_SECRETS"], "true", StringComparison.OrdinalIgnoreCase);
            o.EmbedJwtSecret = configuration["EMBED_JWT_SECRET"] ?? o.EmbedJwtSecret;
            o.EmbedJwtAudience = configuration["EMBED_JWT_AUDIENCE"] ?? o.EmbedJwtAudience;
            if (int.TryParse(configuration["EMBED_JWT_LIFETIME_MINUTES"], out var em) && em > 0)
                o.EmbedJwtLifetimeMinutes = em;
        });

        services.Configure<FeatureOptions>(o =>
        {
            var autoFlag = configuration["FEATURE_AUTO_CALL_AUDIO"]
                ?? Environment.GetEnvironmentVariable("FEATURE_AUTO_CALL_AUDIO");
            if (string.Equals(autoFlag, "0", StringComparison.OrdinalIgnoreCase)
                || string.Equals(autoFlag, "false", StringComparison.OrdinalIgnoreCase)
                || string.Equals(autoFlag, "off", StringComparison.OrdinalIgnoreCase))
            {
                o.AutoCallAudio = false;
            }
        });

        services.Configure<RecordingRuntimeOptions>(o =>
        {
            o.RecordingsPath = configuration["RECORDINGS_PATH"] ?? o.RecordingsPath;
            o.EgressOutput = (configuration["EGRESS_OUTPUT"] ?? o.EgressOutput).Trim();
            if (int.TryParse(configuration["RECORDING_FINALIZE_TIMEOUT_SECONDS"], out var ft) && ft > 0)
                o.FinalizeTimeoutSeconds = ft;
            if (int.TryParse(configuration["RECORDING_RECONCILE_SECONDS"], out var rs) && rs > 0)
                o.ReconcileSeconds = rs;
            if (int.TryParse(configuration["RECORDING_RECONCILE_BATCH"], out var rb) && rb > 0)
                o.ReconcileBatch = rb;
            if (int.TryParse(configuration["RECORDING_RECONCILE_GRACE_SECONDS"], out var rg) && rg >= 0)
                o.ReconcileGraceSeconds = rg;
            if (int.TryParse(configuration["RECORDING_RETENTION_DAYS"], out var rd) && rd > 0)
                o.RetentionDays = rd;
        });

        services.Configure<DentalVideoOptions>(o =>
        {
            o.EncodingMode = (configuration["DENTAL_ENCODING_MODE"] ?? o.EncodingMode).Trim();
            if (int.TryParse(configuration["DENTAL_MAX_WIDTH"], out var mw) && mw > 0) o.MaxWidth = mw;
            if (int.TryParse(configuration["DENTAL_MAX_HEIGHT"], out var mh) && mh > 0) o.MaxHeight = mh;
            if (int.TryParse(configuration["DENTAL_MAX_FPS"], out var mf) && mf > 0) o.MaxFps = mf;
            if (int.TryParse(configuration["DENTAL_FALLBACK_WIDTH"], out var fw) && fw > 0) o.FallbackWidth = fw;
            if (int.TryParse(configuration["DENTAL_FALLBACK_HEIGHT"], out var fh) && fh > 0) o.FallbackHeight = fh;
            if (int.TryParse(configuration["DENTAL_FALLBACK_FPS"], out var ff) && ff > 0) o.FallbackFps = ff;
            if (int.TryParse(configuration["DENTAL_BITRATE_360P_KBPS"], out var b360) && b360 > 0)
                o.Bitrate360pKbps = b360;
            if (int.TryParse(configuration["DENTAL_BITRATE_480P_KBPS"], out var b480) && b480 > 0)
                o.Bitrate480pKbps = b480;
            if (int.TryParse(configuration["DENTAL_BITRATE_540P_KBPS"], out var b540) && b540 > 0)
                o.Bitrate540pKbps = b540;
            if (int.TryParse(configuration["DENTAL_BITRATE_720P20_KBPS"], out var b720_20) && b720_20 > 0)
                o.Bitrate720p20Kbps = b720_20;
            if (int.TryParse(configuration["DENTAL_BITRATE_720P30_KBPS"], out var b720_30) && b720_30 > 0)
                o.Bitrate720p30Kbps = b720_30;
            // Legacy alias
            if (int.TryParse(configuration["DENTAL_BITRATE_720_KBPS"], out var b720) && b720 > 0
                && string.IsNullOrWhiteSpace(configuration["DENTAL_BITRATE_720P30_KBPS"]))
                o.Bitrate720p30Kbps = b720;
            if (int.TryParse(configuration["DENTAL_MIN_BITRATE_KBPS"], out var bmin) && bmin > 0)
                o.MinBitrateKbps = bmin;
            if (int.TryParse(configuration["DENTAL_MAX_BITRATE_KBPS"], out var bmax) && bmax > 0)
                o.MaxBitrateKbps = bmax;

            o.OptimizeEnabled =
                string.Equals(configuration["DENTAL_VIDEO_OPTIMIZE_ENABLED"], "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(configuration["DENTAL_VIDEO_OPTIMIZE_ENABLED"], "true", StringComparison.OrdinalIgnoreCase);
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_CRF"], out var crf) && crf is >= 16 and <= 32)
                o.OptimizeCrf = crf;
            if (!string.IsNullOrWhiteSpace(configuration["DENTAL_VIDEO_OPTIMIZE_PRESET"]))
                o.OptimizePreset = configuration["DENTAL_VIDEO_OPTIMIZE_PRESET"]!.Trim();
            o.DeleteOriginalAfterOptimize =
                string.Equals(configuration["DENTAL_VIDEO_DELETE_ORIGINAL_AFTER_OPTIMIZE"], "1", StringComparison.OrdinalIgnoreCase)
                || string.Equals(configuration["DENTAL_VIDEO_DELETE_ORIGINAL_AFTER_OPTIMIZE"], "true", StringComparison.OrdinalIgnoreCase);
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_INTERVAL_SECONDS"], out var oi) && oi > 0)
                o.OptimizeIntervalSeconds = oi;
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_BATCH"], out var ob) && ob > 0)
                o.OptimizeBatch = ob;
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_TIMEOUT_SECONDS"], out var ot) && ot > 0)
                o.OptimizeTimeoutSeconds = ot;
            if (int.TryParse(configuration["DENTAL_PROBE_TIMEOUT_SECONDS"], out var pt) && pt > 0)
                o.ProbeTimeoutSeconds = pt;
            if (double.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_MIN_SAVING_PERCENT"],
                    System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var msp))
                o.MinSavingPercent = msp;
            if (long.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_MIN_ORIGINAL_BYTES"], out var mob) && mob >= 0)
                o.MinOriginalBytes = mob;
            if (long.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_MIN_DURATION_MS"], out var md) && md >= 0)
                o.MinDurationMs = md;
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_MAX_ATTEMPTS"], out var ma) && ma > 0)
                o.OptimizeMaxAttempts = ma;
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_LEASE_SECONDS"], out var ls) && ls > 0)
                o.OptimizeLeaseSeconds = ls;
            if (int.TryParse(configuration["DENTAL_VIDEO_OPTIMIZE_RETRY_BACKOFF_SECONDS"], out var rb) && rb > 0)
                o.OptimizeRetryBackoffSeconds = rb;
        });

        return services;
    }

    /// <summary>
    /// Fail-fast after host build: LiveKit secret + existing S3 capability rules.
    /// Does not log secret values.
    /// </summary>
    public static void ValidatePocOptionsOrThrow(WebApplication app)
    {
        var lk = app.Services.GetRequiredService<IOptions<LiveKitOptions>>().Value;
        if (string.IsNullOrWhiteSpace(lk.ApiSecret))
            throw new InvalidOperationException("LIVEKIT_API_SECRET is required (typed LiveKitOptions)." );

        if (string.IsNullOrWhiteSpace(lk.HttpUrl)
            || !Uri.TryCreate(lk.HttpUrl, UriKind.Absolute, out _))
            throw new InvalidOperationException("LIVEKIT_HTTP_URL must be an absolute URL." );

        var auth = app.Services.GetRequiredService<IOptions<AuthOptions>>().Value;
        if (auth.RequireStrictSecrets && string.IsNullOrWhiteSpace(auth.JwtSecret))
            throw new InvalidOperationException("REQUIRE_STRICT_SECRETS=1 requires JWT_SECRET / AUTH_JWT_SECRET." );

        // Existing Phase C S3 rules (mode-aware).
        RecordingS3Config.ValidateOrThrow(app.Configuration, app.Logger);

        var dental = app.Services.GetRequiredService<IOptions<DentalVideoOptions>>().Value;
        dental.ValidateOrThrow();

        app.Logger.LogInformation(
            "Options OK: LiveKit HttpUrl={HttpUrl} ApiKey={ApiKey} AutoCallAudio={Auto} EgressOutput={Egress} DentalMode={Dental} Optimize={Opt}",
            lk.HttpUrl,
            lk.ApiKey,
            app.Services.GetRequiredService<IOptions<FeatureOptions>>().Value.AutoCallAudio,
            app.Services.GetRequiredService<IOptions<RecordingRuntimeOptions>>().Value.EgressOutput,
            dental.EncodingMode,
            dental.OptimizeEnabled);
    }
}
