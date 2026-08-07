using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;

namespace LiveKitPoc.Api;

public sealed class LiveKitTokenService(IOptions<LiveKitOptions> liveKitOptions)
{
    private readonly string _apiKey = liveKitOptions.Value.ApiKey;
    private readonly string _apiSecret = string.IsNullOrWhiteSpace(liveKitOptions.Value.ApiSecret)
        ? throw new InvalidOperationException("LIVEKIT_API_SECRET is required.")
        : liveKitOptions.Value.ApiSecret;

    /// <summary>
    /// Join token for an exact authorized room only — no wildcards.
    /// Identity sub is clinic-scoped: {clinicId}:{userId}.
    /// </summary>
    public (string Token, DateTimeOffset ExpiresAt) CreateJoinToken(
        TestIdentity identity,
        string roomName,
        TimeSpan ttl)
    {
        if (string.IsNullOrWhiteSpace(roomName))
            throw new ArgumentException("Room name is required.", nameof(roomName));

        var now = DateTimeOffset.UtcNow;
        var expiresAt = now.Add(ttl);
        var header = new Dictionary<string, object> { ["alg"] = "HS256", ["typ"] = "JWT" };
        var payload = new Dictionary<string, object?>
        {
            ["iss"] = _apiKey,
            ["sub"] = $"{identity.ClinicId}:{identity.Id}",
            ["name"] = identity.DisplayName,
            ["nbf"] = now.ToUnixTimeSeconds(),
            ["exp"] = expiresAt.ToUnixTimeSeconds(),
            ["jti"] = Guid.NewGuid().ToString("N"),
            ["metadata"] = JsonSerializer.Serialize(new
            {
                identity.Id,
                clinicId = identity.ClinicId,
                // legacy key kept so older tooling that reads tenantId still works
                tenantId = identity.ClinicId
            }),
            ["video"] = new
            {
                roomJoin = true,
                room = roomName,
                canPublish = true,
                canSubscribe = true,
                canPublishData = true
            }
        };

        var encodedHeader = Base64Url(JsonSerializer.SerializeToUtf8Bytes(header));
        var encodedPayload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(payload));
        var unsignedToken = $"{encodedHeader}.{encodedPayload}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_apiSecret));
        var signature = Base64Url(hmac.ComputeHash(Encoding.ASCII.GetBytes(unsignedToken)));
        return ($"{unsignedToken}.{signature}", expiresAt);
    }

    public string CreateRoomRecordToken(TimeSpan ttl)
    {
        var now = DateTimeOffset.UtcNow;
        var header = new Dictionary<string, object> { ["alg"] = "HS256", ["typ"] = "JWT" };
        var payload = new Dictionary<string, object?>
        {
            ["iss"] = _apiKey,
            ["sub"] = "simlydent-recording-service",
            ["nbf"] = now.ToUnixTimeSeconds(),
            ["exp"] = now.Add(ttl).ToUnixTimeSeconds(),
            ["jti"] = Guid.NewGuid().ToString("N"),
            ["video"] = new { roomRecord = true, roomCreate = true }
        };
        return Sign(header, payload);
    }

    /// <summary>
    /// Room admin token scoped to ONE room for RoomService operations:
    /// ListParticipants (track resolution) and SendData (targeted photo command).
    /// Never issued to clients.
    /// </summary>
    public string CreateRoomAdminToken(string roomName, TimeSpan? ttl = null)
    {
        if (string.IsNullOrWhiteSpace(roomName))
            throw new ArgumentException("Room name is required.", nameof(roomName));

        var now = DateTimeOffset.UtcNow;
        var header = new Dictionary<string, object> { ["alg"] = "HS256", ["typ"] = "JWT" };
        var payload = new Dictionary<string, object?>
        {
            ["iss"] = _apiKey,
            ["sub"] = "simlydent-room-admin",
            ["nbf"] = now.ToUnixTimeSeconds(),
            ["exp"] = now.Add(ttl ?? TimeSpan.FromMinutes(2)).ToUnixTimeSeconds(),
            ["jti"] = Guid.NewGuid().ToString("N"),
            ["video"] = new
            {
                roomAdmin = true,
                roomRecord = true,
                roomCreate = true,
                room = roomName
            }
        };
        return Sign(header, payload);
    }

    private string Sign(Dictionary<string, object> header, Dictionary<string, object?> payload)
    {
        var encodedHeader = Base64Url(JsonSerializer.SerializeToUtf8Bytes(header));
        var encodedPayload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(payload));
        var unsignedToken = $"{encodedHeader}.{encodedPayload}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_apiSecret));
        var signature = Base64Url(hmac.ComputeHash(Encoding.ASCII.GetBytes(unsignedToken)));
        return $"{unsignedToken}.{signature}";
    }

    private static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
