using System.Security.Claims;

namespace LiveKitPoc.Api;

public static class ApiAuthMapping
{
    public static AuthUserDto ToUserDto(TestIdentity user) =>
        new(user.Id, user.ClinicId, user.DisplayName, user.Role);
}

public static class LiveKitUrl
{
    public static string WebSocketUrl(HttpRequest request)
    {
        var forwardedProto = request.Headers["X-Forwarded-Proto"].FirstOrDefault();
        var scheme = string.Equals(forwardedProto, "https", StringComparison.OrdinalIgnoreCase) || request.IsHttps
            ? "wss"
            : "ws";
        var forwardedHost = request.Headers["X-Forwarded-Host"].FirstOrDefault();
        var host = string.IsNullOrWhiteSpace(forwardedHost) ? request.Host.Value : forwardedHost;
        return $"{scheme}://{host}";
    }
}

public sealed record LoginRequest(string UserId, string Password);
public sealed record AuthUserDto(string Id, string ClinicId, string DisplayName, string Role = IdentityRoles.Staff)
{
    public string TenantId => ClinicId;
}
public sealed record LoginResponse(string AccessToken, DateTimeOffset ExpiresAt, AuthUserDto User);

public sealed record EmbedSessionRequest(string SiteKey);
public sealed record EmbedSessionResponse(
    string AccessToken,
    DateTimeOffset ExpiresAt,
    string SessionId,
    string ClinicId,
    string SiteId,
    string SiteKey);

/// <summary>Optional body for plant-complete test hook (AgeDays backdates UpdatedAt for retention).</summary>
public sealed record PlantRecordingRequest(int AgeDays = 0);
