using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;

namespace LiveKitPoc.Api;

/// <summary>
/// LiveKit RoomService helpers (ListParticipants/GetParticipant, SendData).
/// Uses roomAdmin token — never issued to clients.
/// </summary>
public sealed class LiveKitRoomService(
    HttpClient httpClient,
    IConfiguration configuration,
    LiveKitTokenService tokens)
{
    private readonly Uri _baseUri = new(configuration["LIVEKIT_HTTP_URL"] ?? "http://livekit:7880");

    /// <summary>
    /// Find patient participant's camera track SID.
    /// Selects track: source=CAMERA, type=VIDEO, not muted.
    /// </summary>
    public async Task<(string participantIdentity, string trackSid)?> FindPatientCameraTrackAsync(
        string roomName,
        string patientParticipantIdentity,
        CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(roomName) || string.IsNullOrWhiteSpace(patientParticipantIdentity))
            return null;

        using var request = CreateRequest(
            "GetParticipant",
            new { room = roomName, identity = patientParticipantIdentity },
            roomName);
        using var response = await httpClient.SendAsync(request, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            // Fallback: ListParticipants and match identity
            return await FindFromListAsync(roomName, patientParticipantIdentity, ct);
        }

        return ExtractCameraTrack(body, patientParticipantIdentity);
    }

    private async Task<(string participantIdentity, string trackSid)?> FindFromListAsync(
        string roomName,
        string patientParticipantIdentity,
        CancellationToken ct)
    {
        using var request = CreateRequest(
            "ListParticipants",
            new { room = roomName },
            roomName);
        using var response = await httpClient.SendAsync(request, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            return null;

        try
        {
            using var doc = JsonDocument.Parse(body);
            if (!doc.RootElement.TryGetProperty("participants", out var parts)
                && !doc.RootElement.TryGetProperty("Participants", out parts))
                return null;

            // Pass 1: exact identity
            foreach (var p in parts.EnumerateArray())
            {
                var identity = p.TryGetProperty("identity", out var idEl) ? idEl.GetString() : null;
                if (!IdentityMatches(identity, patientParticipantIdentity))
                    continue;
                var track = ExtractCameraTrackFromParticipant(p);
                if (track is not null)
                    return (identity ?? patientParticipantIdentity, track);
            }

            // Pass 2: any remote participant with a live camera (staff already filtered client-side)
            foreach (var p in parts.EnumerateArray())
            {
                var identity = p.TryGetProperty("identity", out var idEl) ? idEl.GetString() : null;
                var track = ExtractCameraTrackFromParticipant(p);
                if (track is not null && !string.IsNullOrWhiteSpace(identity))
                    return (identity, track);
            }
        }
        catch (JsonException)
        {
            return null;
        }

        return null;
    }

    private static bool IdentityMatches(string? roomIdentity, string requested)
    {
        if (string.IsNullOrWhiteSpace(roomIdentity) || string.IsNullOrWhiteSpace(requested))
            return false;
        if (string.Equals(roomIdentity, requested, StringComparison.OrdinalIgnoreCase))
            return true;
        // clinic-a:visitor:xxx vs visitor:xxx
        if (roomIdentity.EndsWith(":" + requested, StringComparison.OrdinalIgnoreCase))
            return true;
        if (requested.EndsWith(":" + roomIdentity, StringComparison.OrdinalIgnoreCase))
            return true;
        if (roomIdentity.Contains(requested, StringComparison.OrdinalIgnoreCase))
            return true;
        if (requested.Contains(roomIdentity, StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }

    private static (string participantIdentity, string trackSid)? ExtractCameraTrack(
        string body, string identity)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            // GetParticipant may wrap under "participant" or return participant directly
            var p = root;
            if (root.TryGetProperty("participant", out var nested))
                p = nested;
            var track = ExtractCameraTrackFromParticipant(p);
            return track is null ? null : (identity, track);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static string? ExtractCameraTrackFromParticipant(JsonElement p)
    {
        if (!p.TryGetProperty("tracks", out var tracks)
            && !p.TryGetProperty("Tracks", out tracks))
            return null;

        foreach (var t in tracks.EnumerateArray())
        {
            var type = t.TryGetProperty("type", out var typeEl)
                ? typeEl.ToString()
                : (t.TryGetProperty("Type", out typeEl) ? typeEl.ToString() : "");
            var source = t.TryGetProperty("source", out var srcEl)
                ? srcEl.ToString()
                : (t.TryGetProperty("Source", out srcEl) ? srcEl.ToString() : "");
            var muted = t.TryGetProperty("muted", out var mEl) && mEl.ValueKind == JsonValueKind.True
                        || t.TryGetProperty("Muted", out mEl) && mEl.ValueKind == JsonValueKind.True;
            var sid = t.TryGetProperty("sid", out var sidEl)
                ? sidEl.GetString()
                : (t.TryGetProperty("Sid", out sidEl) ? sidEl.GetString() : null);

            // LiveKit: type VIDEO=1 or "VIDEO"/"TRACK_TYPE_VIDEO"; source CAMERA=1 or "CAMERA"/"SOURCE_CAMERA"
            var isVideo = type.Contains("VIDEO", StringComparison.OrdinalIgnoreCase)
                          || type is "1";
            var isCamera = source.Contains("CAMERA", StringComparison.OrdinalIgnoreCase)
                           || source is "1";
            if (isVideo && isCamera && !muted && !string.IsNullOrWhiteSpace(sid))
                return sid;
        }

        // Fallback: any non-muted video track
        foreach (var t in tracks.EnumerateArray())
        {
            var type = t.TryGetProperty("type", out var typeEl) ? typeEl.ToString() : "";
            var muted = t.TryGetProperty("muted", out var mEl) && mEl.ValueKind == JsonValueKind.True;
            var sid = t.TryGetProperty("sid", out var sidEl) ? sidEl.GetString() : null;
            var isVideo = type.Contains("VIDEO", StringComparison.OrdinalIgnoreCase) || type is "1";
            if (isVideo && !muted && !string.IsNullOrWhiteSpace(sid))
                return sid;
        }

        return null;
    }

    /// <summary>
    /// Send data to specific participant via RoomService (server-side, targeted).
    /// </summary>
    public async Task SendDataToParticipantAsync(
        string roomName,
        string destinationIdentity,
        byte[] data,
        bool reliable = true,
        CancellationToken ct = default)
    {
        // LiveKit SendDataRequest: data is base64 in JSON for twirp JSON binding
        // LiveKit SendDataRequest: kind 0=RELIABLE, 1=LOSSY; data is base64 in JSON.
        var payload = new Dictionary<string, object?>
        {
            ["room"] = roomName,
            ["data"] = Convert.ToBase64String(data),
            ["kind"] = reliable ? 0 : 1,
            ["destination_identities"] = new[] { destinationIdentity }
        };

        using var request = CreateRequest("SendData", payload, roomName);
        using var response = await httpClient.SendAsync(request, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            var msg = TryReadError(body) ?? $"RoomService SendData HTTP {(int)response.StatusCode}";
            throw new InvalidOperationException(msg);
        }
    }

    private HttpRequestMessage CreateRequest(string method, object payload, string roomName)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(_baseUri, $"/twirp/livekit.RoomService/{method}"));
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            tokens.CreateRoomAdminToken(roomName, TimeSpan.FromMinutes(2)));
        request.Content = JsonContent.Create(payload);
        return request;
    }

    private static string? TryReadError(string body)
    {
        try
        {
            using var json = JsonDocument.Parse(body);
            if (json.RootElement.TryGetProperty("msg", out var message)) return message.GetString();
            if (json.RootElement.TryGetProperty("message", out message)) return message.GetString();
        }
        catch (JsonException)
        {
            // fall through
        }
        return string.IsNullOrWhiteSpace(body) ? null : body;
    }
}
