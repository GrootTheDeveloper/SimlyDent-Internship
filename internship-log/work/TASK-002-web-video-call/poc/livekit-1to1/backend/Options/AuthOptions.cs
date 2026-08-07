namespace LiveKitPoc.Api.Options;

/// <summary>Staff JWT settings (flat env: JWT_* / AUTH_JWT_SECRET).</summary>
public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    public string JwtSecret { get; set; } = "";
    public string JwtIssuer { get; set; } = "simlydent-livekit-poc";
    public string JwtAudience { get; set; } = "simlydent-livekit-poc-web";
    public int JwtLifetimeMinutes { get; set; } = 480;
    public bool RequireStrictSecrets { get; set; }

    public string EmbedJwtSecret { get; set; } = "";
    public string EmbedJwtAudience { get; set; } = "simlydent-embed";
    public int EmbedJwtLifetimeMinutes { get; set; } = 120;
}
