using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LiveKitPoc.Api;

public sealed class LiveKitEgressService(
    HttpClient httpClient,
    IConfiguration configuration,
    LiveKitTokenService tokens)
{
    private readonly Uri _baseUri = new(configuration["LIVEKIT_HTTP_URL"] ?? "http://livekit:7880");
    private readonly string _recordingsPath = configuration["RECORDINGS_PATH"] ?? "/recordings";

    /// <summary>
    /// Start room composite egress. Video uses H264 preset; AudioOnly sets audio_only=true
    /// (LiveKit RoomCompositeOptions.audioOnly).
    /// </summary>
    public async Task<EgressResult> StartRoomRecordingAsync(
        string roomName,
        string fileName,
        RecordingMode mode,
        CancellationToken cancellationToken)
    {
        if (mode is not (RecordingMode.Video or RecordingMode.AudioOnly))
            throw new InvalidOperationException("Egress is only started for Video or AudioOnly modes.");

        await EnsureRoomAsync(roomName, cancellationToken);

        var audioOnly = mode == RecordingMode.AudioOnly;
        // Audio-only composite still uses a media container; OGG/MP4 depending on egress version.
        // Prefer MP4 for both so local file checks stay consistent; audio_only drops video tracks.
        var request = new Dictionary<string, object?>
        {
            ["room_name"] = roomName,
            ["layout"] = "grid",
            ["audio_only"] = audioOnly,
            ["file_outputs"] = new[]
            {
                new Dictionary<string, object?>
                {
                    ["file_type"] = "MP4",
                    ["filepath"] = $"/out/{fileName}"
                }
            }
        };
        if (!audioOnly)
            request["preset"] = "H264_720P_30";

        return await PostAsync("StartRoomCompositeEgress", request, cancellationToken);
    }

    private async Task EnsureRoomAsync(string roomName, CancellationToken cancellationToken)
    {
        using var request = CreateRequest(
            "RoomService",
            "CreateRoom",
            new { name = roomName, empty_timeout = 60, max_participants = 3 });
        using var response = await httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var message = TryReadError(body) ?? $"LiveKit RoomService returned HTTP {(int)response.StatusCode}.";
            throw new InvalidOperationException(message);
        }
    }

    public async Task<EgressResult> StopRecordingAsync(
        string egressId,
        string fileName,
        CancellationToken cancellationToken)
    {
        await PostAsync("StopEgress", new { egress_id = egressId }, cancellationToken);
        for (var attempt = 0; attempt < 60; attempt++)
        {
            var result = await GetEgressAsync(egressId, cancellationToken);
            var status = result.Status?.ToUpperInvariant() ?? string.Empty;
            if (status is "EGRESS_COMPLETE" or "COMPLETE")
            {
                var path = Path.Combine(_recordingsPath, Path.GetFileName(fileName));
                if (!File.Exists(path))
                    throw new InvalidOperationException("Egress completed but the recording file was not found.");
                return result;
            }
            if (status is "EGRESS_FAILED" or "FAILED" or "EGRESS_ABORTED" or "ABORTED" or "EGRESS_LIMIT_REACHED" or "LIMIT_REACHED")
                throw new InvalidOperationException(result.Error ?? $"Egress stopped with status {result.Status}.");
            await Task.Delay(500, cancellationToken);
        }
        throw new TimeoutException("Timed out while waiting for Egress to finalize the recording.");
    }

    public string GetLocalEgressPath(string fileName) =>
        Path.Combine(_recordingsPath, Path.GetFileName(fileName));

    private async Task<EgressResult> GetEgressAsync(string egressId, CancellationToken cancellationToken)
    {
        using var request = CreateRequest("Egress", "ListEgress", new { egress_id = egressId });
        using var response = await httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(TryReadError(body) ?? $"LiveKit Egress returned HTTP {(int)response.StatusCode}.");
        var list = JsonSerializer.Deserialize<EgressListResult>(body);
        return list?.Items?.FirstOrDefault()
            ?? throw new InvalidOperationException("LiveKit Egress did not return the requested recording.");
    }

    private async Task<EgressResult> PostAsync(
        string method,
        object payload,
        CancellationToken cancellationToken)
    {
        using var request = CreateRequest("Egress", method, payload);

        using var response = await httpClient.SendAsync(request, cancellationToken);
        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var message = TryReadError(body) ?? $"LiveKit Egress returned HTTP {(int)response.StatusCode}.";
            throw new InvalidOperationException(message);
        }

        var result = JsonSerializer.Deserialize<EgressResult>(body);
        return result ?? throw new InvalidOperationException("LiveKit Egress returned an empty response.");
    }

    private HttpRequestMessage CreateRequest(string service, string method, object payload)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post,
            new Uri(_baseUri, $"/twirp/livekit.{service}/{method}"));
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer",
            tokens.CreateRoomRecordToken(TimeSpan.FromMinutes(2)));
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
            // Return the raw response below when it is not JSON.
        }
        return string.IsNullOrWhiteSpace(body) ? null : body;
    }
}

public sealed record EgressResult(
    [property: JsonPropertyName("egress_id")] string EgressId,
    [property: JsonPropertyName("room_name")] string? RoomName,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("error")] string? Error);

public sealed record EgressListResult(
    [property: JsonPropertyName("items")] EgressResult[]? Items);
