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

        app.Logger.LogInformation(
            "Options OK: LiveKit HttpUrl={HttpUrl} ApiKey={ApiKey} AutoCallAudio={Auto} EgressOutput={Egress}",
            lk.HttpUrl,
            lk.ApiKey,
            app.Services.GetRequiredService<IOptions<FeatureOptions>>().Value.AutoCallAudio,
            app.Services.GetRequiredService<IOptions<RecordingRuntimeOptions>>().Value.EgressOutput);
    }
}
