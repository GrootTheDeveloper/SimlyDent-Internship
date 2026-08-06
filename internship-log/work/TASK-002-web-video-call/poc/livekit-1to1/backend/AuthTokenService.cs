using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Microsoft.AspNetCore.Identity;
using Microsoft.IdentityModel.Tokens;

namespace LiveKitPoc.Api;

public sealed class AuthTokenService
{
    public const string ClaimUserId = ClaimTypes.NameIdentifier;
    /// <summary>Canonical clinic claim for TASK-003.</summary>
    public const string ClaimClinicId = "clinic_id";
    /// <summary>Legacy alias of clinic_id (same value) for older clients/tools.</summary>
    public const string ClaimTenantId = "tenant_id";
    public const string ClaimDisplayName = "display_name";

    private readonly string _signingKey;
    private readonly string _issuer;
    private readonly string _audience;
    private readonly TimeSpan _lifetime;
    private readonly PasswordHasher<TestIdentity> _passwordHasher = new();

    public AuthTokenService(IConfiguration configuration)
    {
        var requireStrict = string.Equals(
            configuration["REQUIRE_STRICT_SECRETS"], "1", StringComparison.OrdinalIgnoreCase);
        var configured = configuration["JWT_SECRET"] ?? configuration["AUTH_JWT_SECRET"];
        if (requireStrict)
        {
            if (string.IsNullOrWhiteSpace(configured)
                || configured.Contains("change-me", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException(
                    "REQUIRE_STRICT_SECRETS=1: set a strong JWT_SECRET (no dev default).");
            }
            _signingKey = configured;
        }
        else
        {
            _signingKey = configured ?? "simlydent-poc-dev-jwt-secret-change-me-32chars!!";
        }
        _issuer = configuration["JWT_ISSUER"] ?? "simlydent-livekit-poc";
        _audience = configuration["JWT_AUDIENCE"] ?? "simlydent-livekit-poc-web";
        var minutes = int.TryParse(configuration["JWT_LIFETIME_MINUTES"], out var m) ? m : 480;
        _lifetime = TimeSpan.FromMinutes(Math.Clamp(minutes, 15, 24 * 60));
    }

    public string HashPassword(TestIdentity user, string password) =>
        _passwordHasher.HashPassword(user, password);

    public bool VerifyPassword(TestIdentity user, string passwordHash, string password)
    {
        var result = _passwordHasher.VerifyHashedPassword(user, passwordHash, password);
        return result is PasswordVerificationResult.Success
            or PasswordVerificationResult.SuccessRehashNeeded;
    }

    public (string AccessToken, DateTimeOffset ExpiresAt) CreateAccessToken(TestIdentity user)
    {
        var expires = DateTimeOffset.UtcNow.Add(_lifetime);
        // ClinicId is server-owned from IdentityRegistry at login time.
        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, user.Id),
            new(ClaimUserId, user.Id),
            new(ClaimClinicId, user.ClinicId),
            new(ClaimTenantId, user.ClinicId), // compatibility alias
            new(ClaimDisplayName, user.DisplayName),
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

        return (new JwtSecurityTokenHandler().WriteToken(token), expires);
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
            NameClaimType = ClaimUserId
        };
    }
}
