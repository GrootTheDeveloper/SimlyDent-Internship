using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.IdentityModel.Tokens;

namespace LiveKitPoc.Api;

/// <summary>
/// Embed visitor session JWT — separate audience/token_use from staff JWT.
/// Does not use IdentityRegistry.
/// </summary>
public sealed class EmbedAuthTokenService
{
    public const string AuthenticationScheme = "EmbedBearer";
    public const string ClaimSessionId = "session_id";
    public const string ClaimClinicId = "clinic_id";
    public const string ClaimSiteId = "site_id";
    public const string ClaimSiteKey = "site_key";
    public const string ClaimTokenUse = "token_use";
    public const string TokenUseEmbed = "embed";
    public const string DefaultAudience = "simlydent-embed";

    private readonly string _signingKey;
    private readonly string _issuer;
    private readonly string _audience;
    private readonly TimeSpan _lifetime;
    private readonly ILogger<EmbedAuthTokenService> _log;

    public EmbedAuthTokenService(IConfiguration configuration, ILogger<EmbedAuthTokenService> log)
    {
        _log = log;
        var requireStrict = string.Equals(
            configuration["REQUIRE_STRICT_SECRETS"], "1", StringComparison.OrdinalIgnoreCase);

        var staffSecret = configuration["JWT_SECRET"]
            ?? configuration["AUTH_JWT_SECRET"]
            ?? "";
        var embedSecret = configuration["EMBED_JWT_SECRET"] ?? "";

        if (requireStrict)
        {
            if (string.IsNullOrWhiteSpace(staffSecret)
                || staffSecret.Contains("change-me", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "REQUIRE_STRICT_SECRETS=1: set a strong JWT_SECRET (no dev default).");
            }
            if (string.IsNullOrWhiteSpace(embedSecret)
                || embedSecret.Contains("change-me", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "REQUIRE_STRICT_SECRETS=1: set EMBED_JWT_SECRET (do not use empty/dev default).");
            }
            _signingKey = embedSecret;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(embedSecret))
            {
                _signingKey = string.IsNullOrWhiteSpace(staffSecret)
                    ? "simlydent-poc-dev-embed-jwt-secret-change-me!!"
                    : staffSecret;
                _log.LogWarning(
                    "EMBED_JWT_SECRET not set; using fallback signing key (dev only). Set EMBED_JWT_SECRET for VPS.");
            }
            else
            {
                _signingKey = embedSecret;
            }
        }

        _issuer = configuration["JWT_ISSUER"] ?? "simlydent-livekit-poc";
        _audience = configuration["EMBED_JWT_AUDIENCE"] ?? DefaultAudience;
        var minutes = int.TryParse(configuration["EMBED_JWT_LIFETIME_MINUTES"], out var m) ? m : 120;
        _lifetime = TimeSpan.FromMinutes(Math.Clamp(minutes, 60, 180));
    }

    public TimeSpan Lifetime => _lifetime;

    public (string AccessToken, DateTimeOffset ExpiresAt, string SessionId) CreateSessionToken(
        ClinicSite site)
    {
        var sessionId = Guid.NewGuid().ToString("N");
        var expires = DateTimeOffset.UtcNow.Add(_lifetime);
        var sub = $"visitor:{sessionId}";
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, sub),
            new(ClaimTypes.NameIdentifier, sub),
            new(ClaimSessionId, sessionId),
            new(ClaimClinicId, site.ClinicId),
            new(ClaimSiteId, site.SiteId),
            new(ClaimSiteKey, site.SiteKey),
            new(ClaimTokenUse, TokenUseEmbed),
            new(JwtRegisteredClaimNames.Jti, Guid.NewGuid().ToString("N"))
        };

        var key = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_signingKey));
        var creds = new SigningCredentials(key, SecurityAlgorithms.HmacSha256);
        var token = new JwtSecurityToken(
            issuer: _issuer,
            audience: _audience,
            claims: claims,
            notBefore: DateTime.UtcNow.AddMinutes(-1),
            expires: expires.UtcDateTime,
            signingCredentials: creds);

        return (new JwtSecurityTokenHandler().WriteToken(token), expires, sessionId);
    }

    public TokenValidationParameters ValidationParameters()
    {
        return new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidIssuer = _issuer,
            ValidateAudience = true,
            ValidAudience = _audience,
            ValidateIssuerSigningKey = true,
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(_signingKey)),
            ValidateLifetime = true,
            ClockSkew = TimeSpan.FromMinutes(1),
            NameClaimType = ClaimTypes.NameIdentifier
        };
    }

    public static EmbedSession? TryReadSession(ClaimsPrincipal? principal)
    {
        if (principal?.Identity?.IsAuthenticated != true) return null;
        var tokenUse = principal.FindFirstValue(ClaimTokenUse);
        if (!string.Equals(tokenUse, TokenUseEmbed, StringComparison.OrdinalIgnoreCase))
            return null;
        var sessionId = principal.FindFirstValue(ClaimSessionId);
        var clinicId = principal.FindFirstValue(ClaimClinicId);
        var siteId = principal.FindFirstValue(ClaimSiteId);
        var siteKey = principal.FindFirstValue(ClaimSiteKey);
        var sub = principal.FindFirstValue(ClaimTypes.NameIdentifier)
                  ?? principal.FindFirstValue("sub");
        if (string.IsNullOrWhiteSpace(sessionId)
            || string.IsNullOrWhiteSpace(clinicId)
            || string.IsNullOrWhiteSpace(sub))
            return null;
        return new EmbedSession(sessionId, clinicId, siteId ?? "", siteKey ?? "", sub);
    }
}

public sealed record EmbedSession(
    string SessionId,
    string ClinicId,
    string SiteId,
    string SiteKey,
    string VisitorId);
