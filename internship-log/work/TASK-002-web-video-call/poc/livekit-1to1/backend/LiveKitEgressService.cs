using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace LiveKitPoc.Api;

public enum DentalQualityProfile
{
    /// <summary>Benchmark target — only when source track confirmed &gt;= 1080p.</summary>
    HD_1080p_30,
    /// <summary>Safe fallback for most mobile cameras.</summary>
    HD_720p_30
}

public sealed class LiveKitEgressService(
    HttpClient httpClient,
    IOptions<LiveKitOptions> liveKitOptions,
    IOptions<RecordingRuntimeOptions> recordingOptions,
    IConfiguration configuration,
    LiveKitTokenService tokens)
{
    private readonly Uri _baseUri = new(liveKitOptions.Value.HttpUrl);
    private readonly string _recordingsPath = recordingOptions.Value.RecordingsPath;
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

    /// <summary>
    /// RoomCompositeEgress audio-only. No layout, no video encoder.
    /// Output: MP3 (browser-playable).
    /// Note: LiveKit audio-only composite must NOT include layout or custom_base_url.
    /// </summary>
    public async Task<EgressResult> StartRoomAudioRecordingAsync(
        string roomName,
        string fileName,
        string? storageKey = null,
        CancellationToken cancellationToken = default)
    {
        await EnsureRoomAsync(roomName, cancellationToken);
        var fileOutput = BuildFileOutput(fileName, storageKey);
        fileOutput["file_type"] = "MP3";
        var request = new Dictionary<string, object?>
        {
            ["room_name"] = roomName,
            ["audio_only"] = true,
            // NO "layout" — audio-only must not include it
            ["file_outputs"] = new[] { fileOutput }
        };
        return await PostAsync("StartRoomCompositeEgress", request, cancellationToken);
    }

    /// <summary>
    /// TrackCompositeEgress — patient camera video track ONLY (no audio).
    /// Legacy enum path (fixed preset / env advanced with fixed 720p30).
    /// Prefer <see cref="StartTrackCompositeRecordingAsync(string,string,string,string?,DentalEncodeProfile,CancellationToken)"/>.
    /// </summary>
    public Task<EgressResult> StartTrackCompositeRecordingAsync(
        string roomName,
        string videoTrackId,
        string fileName,
        string? storageKey = null,
        DentalQualityProfile profile = DentalQualityProfile.HD_720p_30,
        CancellationToken cancellationToken = default)
    {
        var (width, height, bitrateKbps) = profile switch
        {
            DentalQualityProfile.HD_1080p_30 => (
                ParsePositiveInt(_configuration["DENTAL_WIDTH_1080"], 1920),
                ParsePositiveInt(_configuration["DENTAL_HEIGHT_1080"], 1080),
                ParsePositiveInt(_configuration["DENTAL_BITRATE_1080_KBPS"], 4000)),
            _ => (
                ParsePositiveInt(_configuration["DENTAL_WIDTH_720"], 1280),
                ParsePositiveInt(_configuration["DENTAL_HEIGHT_720"], 720),
                ParsePositiveInt(_configuration["DENTAL_BITRATE_720_KBPS"], 2500))
        };
        var encode = new DentalEncodeProfile(
            width, height, 30, bitrateKbps, "H264_MAIN",
            profile == DentalQualityProfile.HD_1080p_30 ? "legacy-H264_1080P_30" : "legacy-H264_720P_30",
            null, null, null,
            UsedAdvanced: string.Equals(_configuration["DENTAL_ENCODING_MODE"], "advanced", StringComparison.OrdinalIgnoreCase)
                || string.Equals(_configuration["DENTAL_ENCODING_MODE"], "source-aware", StringComparison.OrdinalIgnoreCase));
        return StartTrackCompositeRecordingAsync(
            roomName, videoTrackId, fileName, storageKey, encode, cancellationToken);
    }

    /// <summary>
    /// TrackComposite with source-aware or legacy profile.
    /// When <see cref="DentalEncodeProfile.UsedAdvanced"/>, builds advanced width/height/framerate/bitrate
    /// (no fixed H264_720P_30 preset).
    /// </summary>
    public async Task<EgressResult> StartTrackCompositeRecordingAsync(
        string roomName,
        string videoTrackId,
        string fileName,
        string? storageKey,
        DentalEncodeProfile encode,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(videoTrackId))
            throw new ArgumentException("video_track_id is required.", nameof(videoTrackId));
        ArgumentNullException.ThrowIfNull(encode);

        var request = BuildTrackCompositeRequest(roomName, videoTrackId, fileName, storageKey, encode);
        return await PostAsync("StartTrackCompositeEgress", request, cancellationToken);
    }

    /// <summary>Pure request builder for unit tests / diagnostics.</summary>
    public Dictionary<string, object?> BuildTrackCompositeRequest(
        string roomName,
        string videoTrackId,
        string fileName,
        string? storageKey,
        DentalEncodeProfile encode)
    {
        var fileOutput = BuildFileOutput(fileName, storageKey);
        var request = new Dictionary<string, object?>
        {
            ["room_name"] = roomName,
            ["video_track_id"] = videoTrackId,
            ["file_outputs"] = new[] { fileOutput }
        };

        if (encode.UsedAdvanced)
        {
            request["advanced"] = new Dictionary<string, object?>
            {
                ["width"] = encode.Width,
                ["height"] = encode.Height,
                ["framerate"] = encode.FrameRate,
                ["videoCodec"] = string.IsNullOrWhiteSpace(encode.Codec) ? "H264_MAIN" : encode.Codec,
                ["videoBitrate"] = encode.VideoBitrateKbps
            };
        }
        else
        {
            // Legacy preset path (compatibility)
            request["preset"] = encode.Height >= 1080 && encode.Width >= 1920
                ? "H264_1080P_30"
                : "H264_720P_30";
        }

        return request;
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
        // HTTPS public host only — no silent http://minio:9000 fallback (fail-fast at startup).
        var key = string.IsNullOrWhiteSpace(storageKey)
            ? fileName.TrimStart('/')
            : storageKey.Replace('\\', '/').TrimStart('/');
        var endpoint = RecordingS3Config.GetPublicEndpoint(_configuration);
        if (string.IsNullOrWhiteSpace(endpoint)
            || !endpoint.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(
                "EGRESS_OUTPUT=s3 requires S3_PUBLIC_ENDPOINT=https://s3.DOMAIN (no path prefix).");
        var bucket = _configuration["S3_BUCKET"]
                     ?? throw new InvalidOperationException("S3_BUCKET is required for direct S3 egress.");
        var accessKey = _configuration["S3_ACCESS_KEY"]
                        ?? throw new InvalidOperationException("S3_ACCESS_KEY is required for direct S3 egress.");
        var secretKey = _configuration["S3_SECRET_KEY"]
                        ?? throw new InvalidOperationException("S3_SECRET_KEY is required for direct S3 egress.");
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
            var status = (int)response.StatusCode;
            var (twirpCode, twirpMsg) = TryReadTwirp(body);
            var message = twirpMsg ?? TryReadError(body) ?? $"LiveKit RoomService returned HTTP {status}.";
            throw new LiveKitEgressException(
                "CreateRoom",
                LiveKitEgressException.ClassifyHttp(status, twirpCode),
                message,
                httpStatus: status,
                twirpCode: twirpCode,
                twirpMessage: twirpMsg);
        }
    }

    /// <summary>
    /// Bounded timeout for LiveKit Twirp control calls (StopEgress / ListEgress).
    /// Separate from RECORDING_FINALIZE_TIMEOUT (object availability).
    /// </summary>
    public TimeSpan ControlTimeout
    {
        get
        {
            if (int.TryParse(_configuration["EGRESS_CONTROL_TIMEOUT_SECONDS"], out var sec) && sec > 0)
                return TimeSpan.FromSeconds(sec);
            return TimeSpan.FromSeconds(8);
        }
    }

    /// <summary>
    /// Short control-plane StopEgress only — does NOT wait for COMPLETE or materialize files.
    /// Transport timeout keeps recording Finalizing; reconcile is authority.
    /// </summary>
    public async Task RequestStopAsync(string egressId, CancellationToken cancellationToken = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(ControlTimeout);
        await PostAsync("StopEgress", new { egress_id = egressId }, cts.Token);
    }

    public string GetLocalEgressPath(string fileName) =>
        Path.Combine(_recordingsPath, Path.GetFileName(fileName));

    public async Task<EgressResult?> GetEgressStatusAsync(string egressId, CancellationToken cancellationToken = default)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(ControlTimeout);
        try
        {
            using var request = CreateRequest("Egress", "ListEgress", new { egress_id = egressId });
            using var response = await httpClient.SendAsync(request, cts.Token);
            var body = await response.Content.ReadAsStringAsync(cts.Token);
            if (!response.IsSuccessStatusCode)
                throw BuildHttpException("ListEgress", response.StatusCode, body);
            var list = JsonSerializer.Deserialize<EgressListResult>(body);
            return list?.Items?.FirstOrDefault();
        }
        catch (LiveKitEgressException)
        {
            throw;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw WrapTransport("ListEgress", ex);
        }
    }

    private async Task<EgressResult> PostAsync(
        string method,
        object payload,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = CreateRequest("Egress", method, payload);
            using var response = await httpClient.SendAsync(request, cancellationToken);
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw BuildHttpException(method, response.StatusCode, body);

            // StopEgress may return empty body; List/Start return EgressInfo.
            if (string.IsNullOrWhiteSpace(body))
                return new EgressResult(string.Empty, null, null, null);
            var result = JsonSerializer.Deserialize<EgressResult>(body);
            return result ?? new EgressResult(string.Empty, null, null, null);
        }
        catch (LiveKitEgressException)
        {
            throw;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw WrapTransport(method, ex);
        }
    }

    public static LiveKitEgressException BuildHttpException(
        string method,
        System.Net.HttpStatusCode statusCode,
        string body)
    {
        var status = (int)statusCode;
        var (twirpCode, twirpMsg) = TryReadTwirp(body);
        var message = twirpMsg
                      ?? TryReadError(body)
                      ?? $"LiveKit Egress returned HTTP {status}.";
        var classification = LiveKitEgressException.ClassifyHttp(status, twirpCode);
        return new LiveKitEgressException(
            method, classification, message,
            httpStatus: status,
            twirpCode: twirpCode,
            twirpMessage: twirpMsg);
    }

    private static LiveKitEgressException WrapTransport(string method, Exception ex)
    {
        var classification = LiveKitEgressException.ClassifyTransport(ex);
        return new LiveKitEgressException(
            method,
            classification,
            $"LiveKit Egress {method} transport failure: {ex.Message}",
            inner: ex);
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
        var (_, msg) = TryReadTwirp(body);
        if (!string.IsNullOrWhiteSpace(msg)) return msg;
        return string.IsNullOrWhiteSpace(body) ? null : body;
    }

    /// <summary>Parse Twirp error JSON: { "code": "...", "msg": "..." }.</summary>
    public static (string? code, string? msg) TryReadTwirp(string body)
    {
        if (string.IsNullOrWhiteSpace(body)) return (null, null);
        try
        {
            using var json = JsonDocument.Parse(body);
            string? code = null;
            string? msg = null;
            if (json.RootElement.TryGetProperty("code", out var c))
                code = c.GetString();
            if (json.RootElement.TryGetProperty("msg", out var m))
                msg = m.GetString();
            else if (json.RootElement.TryGetProperty("message", out m))
                msg = m.GetString();
            return (code, msg);
        }
        catch (JsonException)
        {
            return (null, null);
        }
    }
}

public sealed record EgressResult(
    [property: JsonPropertyName("egress_id")] string EgressId,
    [property: JsonPropertyName("room_name")] string? RoomName,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("error")] string? Error,
    [property: JsonPropertyName("error_code")] int? ErrorCode = null);

public sealed record EgressListResult(
    [property: JsonPropertyName("items")] EgressResult[]? Items);
