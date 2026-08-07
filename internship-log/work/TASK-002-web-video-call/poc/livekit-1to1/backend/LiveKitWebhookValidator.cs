using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LiveKitPoc.Api;

/// <summary>
/// LiveKit webhook: Authorization JWT must be verified against the exact raw POST body
/// (sha256 claim). Never deserialize → re-serialize → hash.
/// </summary>
public sealed class LiveKitWebhookValidator(IConfiguration configuration)
{
    private readonly string _apiKey = configuration["LIVEKIT_API_KEY"] ?? "devkey";
    private readonly string _apiSecret = configuration["LIVEKIT_API_SECRET"]
        ?? throw new InvalidOperationException("LIVEKIT_API_SECRET is required.");

    public bool TryValidate(string? authorizationHeader, string rawBody, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(authorizationHeader))
        {
            error = "missing Authorization";
            return false;
        }

        var token = authorizationHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? authorizationHeader["Bearer ".Length..].Trim()
            : authorizationHeader.Trim();

        var parts = token.Split('.');
        if (parts.Length != 3)
        {
            error = "invalid JWT shape";
            return false;
        }

        try
        {
            var headerJson = Encoding.UTF8.GetString(Base64UrlDecode(parts[0]));
            var payloadJson = Encoding.UTF8.GetString(Base64UrlDecode(parts[1]));
            using var headerDoc = JsonDocument.Parse(headerJson);
            using var payloadDoc = JsonDocument.Parse(payloadJson);

            // Verify HS256 signature over header.payload
            var unsigned = $"{parts[0]}.{parts[1]}";
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(_apiSecret));
            var expectedBytes = hmac.ComputeHash(Encoding.ASCII.GetBytes(unsigned));
            var actualBytes = Base64UrlDecode(parts[2]);
            if (expectedBytes.Length != actualBytes.Length
                || !CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes))
            {
                error = "bad signature";
                return false;
            }

            var payload = payloadDoc.RootElement;
            if (payload.TryGetProperty("iss", out var iss) && iss.GetString() is { } issStr
                && !string.Equals(issStr, _apiKey, StringComparison.Ordinal))
            {
                error = "iss mismatch";
                return false;
            }

            // sha256 of raw body (hex lowercase)
            var bodyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(rawBody)))
                .ToLowerInvariant();
            string? claimHash = null;
            if (payload.TryGetProperty("sha256", out var shaProp))
                claimHash = shaProp.GetString();
            else if (payload.TryGetProperty("sha_256", out shaProp))
                claimHash = shaProp.GetString();

            if (string.IsNullOrWhiteSpace(claimHash))
            {
                error = "missing sha256 claim";
                return false;
            }

            if (!string.Equals(claimHash, bodyHash, StringComparison.OrdinalIgnoreCase))
            {
                error = "payload hash mismatch";
                return false;
            }

            // exp optional soft check
            if (payload.TryGetProperty("exp", out var exp) && exp.TryGetInt64(out var expUnix))
            {
                if (DateTimeOffset.UtcNow.ToUnixTimeSeconds() > expUnix + 60)
                {
                    error = "token expired";
                    return false;
                }
            }

            return true;
        }
        catch (Exception ex)
        {
            error = ex.Message;
            return false;
        }
    }

    private static byte[] Base64UrlDecode(string input)
    {
        var s = input.Replace('-', '+').Replace('_', '/');
        switch (s.Length % 4)
        {
            case 2: s += "=="; break;
            case 3: s += "="; break;
        }
        return Convert.FromBase64String(s);
    }

    private static string Base64UrlEncode(byte[] data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

public sealed class LiveKitWebhookEvent
{
    [JsonPropertyName("event")]
    public string? Event { get; set; }

    [JsonPropertyName("id")]
    public string? Id { get; set; }

    [JsonPropertyName("createdAt")]
    public long? CreatedAt { get; set; }

    [JsonPropertyName("egressInfo")]
    public EgressWebhookInfo? EgressInfo { get; set; }
}

public sealed class EgressWebhookInfo
{
    [JsonPropertyName("egressId")]
    public string? EgressId { get; set; }

    [JsonPropertyName("egress_id")]
    public string? EgressIdSnake { get; set; }

    [JsonPropertyName("roomName")]
    public string? RoomName { get; set; }

    [JsonPropertyName("status")]
    public object? Status { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("errorCode")]
    public int? ErrorCode { get; set; }

    public string? ResolvedEgressId => EgressId ?? EgressIdSnake;

    public string? ResolvedStatus
    {
        get
        {
            if (Status is null) return null;
            if (Status is JsonElement je)
            {
                if (je.ValueKind == JsonValueKind.String) return je.GetString();
                if (je.ValueKind == JsonValueKind.Number) return je.GetInt32().ToString();
            }
            return Status.ToString();
        }
    }
}
