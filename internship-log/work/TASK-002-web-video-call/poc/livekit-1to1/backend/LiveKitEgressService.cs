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
    private readonly IConfiguration _configuration = configuration;

    /// <summary>
    /// Output mode: local disk under /out (lab) or S3-compatible upload from Egress worker (prod path).
    /// Env: EGRESS_OUTPUT=local|s3 (default local).
    /// </summary>
    public bool UsesDirectS3Output =>
        string.Equals(_configuration["EGRESS_OUTPUT"] ?? "local", "s3", StringComparison.OrdinalIgnoreCase)
        || string.Equals(_configuration["EGRESS_OUTPUT"] ?? "local", "minio", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Start room composite egress. Video encoding is env-configurable (preset or advanced).
    /// AudioOnly sets audio_only=true (LiveKit RoomCompositeOptions.audioOnly).
    /// When EGRESS_OUTPUT=s3, file is uploaded by Egress directly (no API PutObject of video bytes).
    /// </summary>
    /// <param name="storageKey">Clinic-scoped object key used as S3 filepath when direct S3 is on.</param>
    public async Task<EgressResult> StartRoomRecordingAsync(
        string roomName,
        string fileName,
        RecordingMode mode,
        string? storageKey = null,
        CancellationToken cancellationToken = default)
    {
        if (mode is not (RecordingMode.Video or RecordingMode.AudioOnly))
            throw new InvalidOperationException("Egress is only started for Video or AudioOnly modes.");

        await EnsureRoomAsync(roomName, cancellationToken);

        var audioOnly = mode == RecordingMode.AudioOnly;
        var fileOutput = BuildFileOutput(fileName, storageKey);
        var request = new Dictionary<string, object?>
        {
            ["room_name"] = roomName,
            ["layout"] = "grid",
            ["audio_only"] = audioOnly,
            ["file_outputs"] = new[] { fileOutput }
        };
        if (!audioOnly)
            ApplyVideoEncodingOptions(request);

        return await PostAsync("StartRoomCompositeEgress", request, cancellationToken);
    }

    private Dictionary<string, object?> BuildFileOutput(string fileName, string? storageKey)
    {
        if (!UsesDirectS3Output)
        {
            return new Dictionary<string, object?>
            {
                ["file_type"] = "MP4",
                ["filepath"] = $"/out/{fileName}"
            };
        }

        // Direct S3: object key is the filepath; Egress worker performs PutObject.
        // Prefer worker-level credentials when possible; request embeds env for MinIO fixture.
        var key = string.IsNullOrWhiteSpace(storageKey)
            ? fileName.TrimStart('/')
            : storageKey.Replace('\\', '/').TrimStart('/');
        var endpoint = (_configuration["S3_ENDPOINT"] ?? "http://minio:9000").TrimEnd('/');
        var bucket = _configuration["S3_BUCKET"] ?? "simlydent-recordings";
        var accessKey = _configuration["S3_ACCESS_KEY"] ?? "minioadmin";
        var secretKey = _configuration["S3_SECRET_KEY"] ?? "minioadmin";
        var region = _configuration["S3_REGION"] ?? "us-east-1";
        var forcePathStyle = !string.Equals(_configuration["S3_PATH_STYLE"], "0", StringComparison.OrdinalIgnoreCase);

        return new Dictionary<string, object?>
        {
            ["file_type"] = "MP4",
            ["filepath"] = key,
            ["s3"] = new Dictionary<string, object?>
            {
                ["access_key"] = accessKey,
                ["secret"] = secretKey,
                ["bucket"] = bucket,
                ["region"] = region,
                ["endpoint"] = endpoint,
                ["force_path_style"] = forcePathStyle
            }
        };
    }

    /// <summary>
    /// Encoding modes (env):
    /// - EGRESS_ENCODING_MODE=preset (default): EGRESS_VIDEO_PRESET (default H264_720P_30)
    /// - EGRESS_ENCODING_MODE=advanced: width/height/framerate + video/audio bitrate (kbps)
    ///
    /// Recommended clinical trial (advanced): 1280x720 @ 20fps, video 1500 kbps, audio 96 kbps.
    /// ~0.55–0.7 GB/h is a conditional size target — pick lowest bitrate that still passes visual QA.
    /// </summary>
    private void ApplyVideoEncodingOptions(Dictionary<string, object?> request)
    {
        var mode = (_configuration["EGRESS_ENCODING_MODE"] ?? "preset").Trim().ToLowerInvariant();
        if (mode is "advanced" or "custom")
        {
            var width = ParsePositiveInt(_configuration["EGRESS_WIDTH"], 1280);
            var height = ParsePositiveInt(_configuration["EGRESS_HEIGHT"], 720);
            var framerate = ParsePositiveInt(_configuration["EGRESS_FRAMERATE"], 20);
            // LiveKit EncodingOptions.videoBitrate / audioBitrate are in kbps.
            var videoBitrateKbps = ParsePositiveInt(_configuration["EGRESS_VIDEO_BITRATE_KBPS"], 1500);
            var audioBitrateKbps = ParsePositiveInt(_configuration["EGRESS_AUDIO_BITRATE_KBPS"], 96);
            var keyFrameInterval = ParsePositiveDouble(_configuration["EGRESS_KEY_FRAME_INTERVAL"], 2.0);

            request["advanced"] = new Dictionary<string, object?>
            {
                ["width"] = width,
                ["height"] = height,
                ["framerate"] = framerate,
                ["audioCodec"] = "AAC",
                ["audioBitrate"] = audioBitrateKbps,
                ["videoCodec"] = "H264_MAIN",
                ["videoBitrate"] = videoBitrateKbps,
                ["keyFrameInterval"] = keyFrameInterval
            };
            return;
        }

        var preset = (_configuration["EGRESS_VIDEO_PRESET"] ?? "H264_720P_30").Trim();
        if (string.IsNullOrWhiteSpace(preset))
            preset = "H264_720P_30";
        request["preset"] = preset;
    }

    private static int ParsePositiveInt(string? raw, int fallback)
    {
        if (int.TryParse(raw, out var n) && n > 0) return n;
        return fallback;
    }

    private static double ParsePositiveDouble(string? raw, double fallback)
    {
        if (double.TryParse(raw, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var n) && n > 0)
            return n;
        return fallback;
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

    /// <summary>
    /// Stop egress and wait until LiveKit reports COMPLETE.
    /// Local mode still checks the file on disk; S3 mode leaves object existence to the caller (HeadObject).
    /// </summary>
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
                if (!UsesDirectS3Output)
                {
                    var path = Path.Combine(_recordingsPath, Path.GetFileName(fileName));
                    if (!File.Exists(path))
                        throw new InvalidOperationException("Egress completed but the recording file was not found.");
                }
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
