using System.Collections.Concurrent;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace LiveKitPoc.Api;

public sealed record QualitySampleBatchRequest(
    string ClientSessionId,
    ClientEnvironmentInfo Environment,
    IReadOnlyList<QualitySample> Samples);

public sealed record ClientEnvironmentInfo(
    string? UserAgent,
    string? Platform,
    string? BrowserLanguage,
    int? HardwareConcurrency,
    double? DeviceMemoryGb,
    int? ScreenWidth,
    int? ScreenHeight,
    double? DevicePixelRatio,
    string? NetworkType,
    double? NetworkDownlinkMbps,
    double? NetworkRttMs,
    string? CameraDeviceId,
    int? CameraWidth,
    int? CameraHeight,
    double? CameraFrameRate);

public sealed record QualitySample(
    DateTimeOffset Timestamp,
    QualityVideoStats? Incoming,
    QualityVideoStats? Outgoing,
    QualityConnectionStats? Connection);

public sealed record QualityVideoStats(
    int? Width,
    int? Height,
    double? Fps,
    double? BitrateKbps,
    double? PacketLossPercent,
    double? JitterMs,
    double? RoundTripTimeMs,
    long? FramesDroppedDelta,
    long? FreezeCountDelta,
    double? FreezeDurationDeltaMs,
    double? AverageProcessingTimeMs,
    double? AverageQp,
    string? QualityLimitationReason,
    string? Codec,
    string? EncoderImplementation,
    string? DecoderImplementation);

public sealed record QualityConnectionStats(
    string? Protocol,
    string? LocalCandidateType,
    string? RemoteCandidateType,
    double? CurrentRoundTripTimeMs,
    double? AvailableOutgoingBitrateKbps,
    double? AvailableIncomingBitrateKbps);

public sealed record QualitySampleEnvelope(
    Guid CallId,
    string TenantId,
    string UserId,
    string ClientSessionId,
    ClientEnvironmentInfo Environment,
    QualitySample Sample);

public sealed record QualityReport(
    Guid CallId,
    DateTimeOffset GeneratedAt,
    int SampleCount,
    IReadOnlyList<QualitySessionReport> Sessions);

public sealed record QualitySessionReport(
    string UserId,
    string ClientSessionId,
    DateTimeOffset StartedAt,
    DateTimeOffset EndedAt,
    double DurationSeconds,
    int SampleCount,
    double NetworkScore0To5,
    IReadOnlyDictionary<string, int> ScoreReasonSamples,
    ClientEnvironmentInfo Environment,
    QualityDirectionSummary Incoming,
    QualityDirectionSummary Outgoing,
    IReadOnlyDictionary<string, double> ConnectionProtocolsPercent);

public sealed record QualityDirectionSummary(
    int SampleCount,
    double AverageBitrateKbps,
    double P5BitrateKbps,
    double AverageFps,
    double P5Fps,
    double AveragePacketLossPercent,
    double P95PacketLossPercent,
    double AverageJitterMs,
    double P95RoundTripTimeMs,
    long FramesDropped,
    long FreezeCount,
    double FreezeDurationMs,
    IReadOnlyDictionary<string, double> ResolutionPercent,
    IReadOnlyDictionary<string, double> LimitationReasonPercent);

public sealed class CallQualityStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _root;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _fileLocks = new(StringComparer.OrdinalIgnoreCase);

    public CallQualityStore(IConfiguration configuration)
    {
        _root = Path.GetFullPath(configuration["QUALITY_LOGS_PATH"] ?? "telemetry");
        Directory.CreateDirectory(_root);
    }

    public async Task AppendAsync(
        CallSession call,
        TestIdentity identity,
        QualitySampleBatchRequest batch,
        CancellationToken cancellationToken)
    {
        var clientSessionId = SafeSegment(batch.ClientSessionId, 80);
        if (string.IsNullOrWhiteSpace(clientSessionId))
            throw new ArgumentException("ClientSessionId is required.");

        var callDirectory = GetCallDirectory(call.Id);
        Directory.CreateDirectory(callDirectory);
        var path = Path.Combine(callDirectory, $"{SafeSegment(identity.Id, 40)}-{clientSessionId}.jsonl");
        var gate = _fileLocks.GetOrAdd(path, _ => new SemaphoreSlim(1, 1));
        var lines = new StringBuilder();
        foreach (var sample in batch.Samples)
        {
            var envelope = new QualitySampleEnvelope(
                call.Id,
                call.TenantId,
                identity.Id,
                clientSessionId,
                batch.Environment,
                sample);
            lines.AppendLine(JsonSerializer.Serialize(envelope, JsonOptions));
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            await File.AppendAllTextAsync(path, lines.ToString(), Encoding.UTF8, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<IReadOnlyList<QualitySampleEnvelope>> ReadAsync(
        Guid callId,
        CancellationToken cancellationToken)
    {
        var directory = GetCallDirectory(callId);
        if (!Directory.Exists(directory)) return [];

        var result = new List<QualitySampleEnvelope>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.jsonl", SearchOption.TopDirectoryOnly))
        {
            var gate = _fileLocks.GetOrAdd(path, _ => new SemaphoreSlim(1, 1));
            await gate.WaitAsync(cancellationToken);
            try
            {
                foreach (var line in await File.ReadAllLinesAsync(path, cancellationToken))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        var item = JsonSerializer.Deserialize<QualitySampleEnvelope>(line, JsonOptions);
                        if (item is not null) result.Add(item);
                    }
                    catch (JsonException)
                    {
                        // A malformed line is isolated so the remaining call report is still usable.
                    }
                }
            }
            finally
            {
                gate.Release();
            }
        }
        return result.OrderBy(item => item.Sample.Timestamp).ToArray();
    }

    public async Task<QualityReport> BuildReportAsync(Guid callId, CancellationToken cancellationToken)
    {
        var samples = await ReadAsync(callId, cancellationToken);
        var sessions = samples
            .GroupBy(item => (item.UserId, item.ClientSessionId))
            .Select(group => BuildSessionReport(group.OrderBy(item => item.Sample.Timestamp).ToArray()))
            .OrderBy(report => report.StartedAt)
            .ToArray();
        return new QualityReport(callId, DateTimeOffset.UtcNow, samples.Count, sessions);
    }

    public static string ToCsv(IEnumerable<QualitySampleEnvelope> samples)
    {
        var output = new StringBuilder();
        output.AppendLine("callId,userId,clientSessionId,timestamp,direction,width,height,fps,bitrateKbps,packetLossPercent,jitterMs,rttMs,framesDroppedDelta,freezeCountDelta,freezeDurationDeltaMs,averageProcessingTimeMs,averageQp,qualityLimitationReason,codec,protocol,localCandidateType,remoteCandidateType,userAgent,platform");
        foreach (var envelope in samples)
        {
            AppendDirection(output, envelope, "incoming", envelope.Sample.Incoming);
            AppendDirection(output, envelope, "outgoing", envelope.Sample.Outgoing);
        }
        return output.ToString();
    }

    private static QualitySessionReport BuildSessionReport(IReadOnlyList<QualitySampleEnvelope> samples)
    {
        var first = samples[0];
        var startedAt = samples.Min(item => item.Sample.Timestamp);
        var endedAt = samples.Max(item => item.Sample.Timestamp);
        var reasonCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var scores = samples.Select(item => CalculateNetworkScore(item.Sample, reasonCounts)).ToArray();
        var protocols = PercentBy(
            samples.Select(item => item.Sample.Connection?.Protocol).Where(value => !string.IsNullOrWhiteSpace(value))!);

        return new QualitySessionReport(
            first.UserId,
            first.ClientSessionId,
            startedAt,
            endedAt,
            Math.Round(Math.Max(0, (endedAt - startedAt).TotalSeconds), 1),
            samples.Count,
            Math.Round(scores.DefaultIfEmpty(5).Average(), 2),
            reasonCounts,
            first.Environment,
            SummarizeDirection(samples.Select(item => item.Sample.Incoming).Where(item => item is not null)!),
            SummarizeDirection(samples.Select(item => item.Sample.Outgoing).Where(item => item is not null)!),
            protocols);
    }

    private static QualityDirectionSummary SummarizeDirection(IEnumerable<QualityVideoStats> values)
    {
        var items = values.ToArray();
        return new QualityDirectionSummary(
            items.Length,
            Average(items.Select(item => item.BitrateKbps)),
            Percentile(items.Select(item => item.BitrateKbps), 0.05),
            Average(items.Select(item => item.Fps)),
            Percentile(items.Select(item => item.Fps), 0.05),
            Average(items.Select(item => item.PacketLossPercent)),
            Percentile(items.Select(item => item.PacketLossPercent), 0.95),
            Average(items.Select(item => item.JitterMs)),
            Percentile(items.Select(item => item.RoundTripTimeMs), 0.95),
            items.Sum(item => item.FramesDroppedDelta ?? 0),
            items.Sum(item => item.FreezeCountDelta ?? 0),
            Math.Round(items.Sum(item => item.FreezeDurationDeltaMs ?? 0), 1),
            PercentBy(items.Select(item => item.Width > 0 && item.Height > 0 ? $"{item.Width}x{item.Height}" : null)
                .Where(value => value is not null)!),
            PercentBy(items.Select(item => item.QualityLimitationReason)
                .Where(value => !string.IsNullOrWhiteSpace(value))!));
    }

    private static double CalculateNetworkScore(QualitySample sample, IDictionary<string, int> reasons)
    {
        var score = 5d;
        var rtt = new[]
        {
            sample.Connection?.CurrentRoundTripTimeMs,
            sample.Incoming?.RoundTripTimeMs,
            sample.Outgoing?.RoundTripTimeMs
        }.Where(value => value.HasValue).Select(value => value!.Value).DefaultIfEmpty(0).Max();
        if (rtt > 300)
        {
            score -= 2;
            Increment(reasons, "rtt-over-300ms");
        }
        else if (rtt >= 150)
        {
            score -= 1;
            Increment(reasons, "rtt-150-to-300ms");
        }

        var loss = new[] { sample.Incoming?.PacketLossPercent, sample.Outgoing?.PacketLossPercent }
            .Where(value => value.HasValue).Select(value => value!.Value).DefaultIfEmpty(0).Max();
        if (loss > 20)
        {
            score -= 5;
            Increment(reasons, "packet-loss-over-20pct");
        }
        else if (loss >= 5)
        {
            score -= 2;
            Increment(reasons, "packet-loss-5-to-20pct");
        }
        else if (loss >= 1)
        {
            score -= 1;
            Increment(reasons, "packet-loss-1-to-5pct");
        }
        return Math.Max(0, score);
    }

    private static void AppendDirection(
        StringBuilder output,
        QualitySampleEnvelope envelope,
        string direction,
        QualityVideoStats? media)
    {
        if (media is null) return;
        var row = new object?[]
        {
            envelope.CallId, envelope.UserId, envelope.ClientSessionId, envelope.Sample.Timestamp,
            direction, media.Width, media.Height, media.Fps, media.BitrateKbps,
            media.PacketLossPercent, media.JitterMs, media.RoundTripTimeMs,
            media.FramesDroppedDelta, media.FreezeCountDelta, media.FreezeDurationDeltaMs,
            media.AverageProcessingTimeMs, media.AverageQp, media.QualityLimitationReason,
            media.Codec, envelope.Sample.Connection?.Protocol,
            envelope.Sample.Connection?.LocalCandidateType, envelope.Sample.Connection?.RemoteCandidateType,
            envelope.Environment.UserAgent, envelope.Environment.Platform
        };
        output.AppendLine(string.Join(',', row.Select(Csv)));
    }

    private string GetCallDirectory(Guid callId) => Path.Combine(_root, $"call-{callId:N}");

    private static string SafeSegment(string value, int maxLength) =>
        new(value.Where(character => char.IsLetterOrDigit(character) || character is '-' or '_')
            .Take(maxLength).ToArray());

    private static double Average(IEnumerable<double?> values)
    {
        var items = values.Where(value => value.HasValue && double.IsFinite(value.Value))
            .Select(value => value!.Value).ToArray();
        return items.Length == 0 ? 0 : Math.Round(items.Average(), 2);
    }

    private static double Percentile(IEnumerable<double?> values, double percentile)
    {
        var items = values.Where(value => value.HasValue && double.IsFinite(value.Value))
            .Select(value => value!.Value).Order().ToArray();
        if (items.Length == 0) return 0;
        var index = (int)Math.Ceiling(percentile * items.Length) - 1;
        return Math.Round(items[Math.Clamp(index, 0, items.Length - 1)], 2);
    }

    private static IReadOnlyDictionary<string, double> PercentBy(IEnumerable<string> values)
    {
        var items = values.Where(value => !string.IsNullOrWhiteSpace(value)).ToArray();
        if (items.Length == 0) return new Dictionary<string, double>();
        return items.GroupBy(value => value, StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(group => group.Count())
            .ToDictionary(
                group => group.Key,
                group => Math.Round(group.Count() * 100d / items.Length, 1),
                StringComparer.OrdinalIgnoreCase);
    }

    private static void Increment(IDictionary<string, int> values, string key) =>
        values[key] = values.TryGetValue(key, out var count) ? count + 1 : 1;

    private static string Csv(object? value)
    {
        var text = value switch
        {
            null => string.Empty,
            IFormattable formattable => formattable.ToString(null, CultureInfo.InvariantCulture),
            _ => value.ToString() ?? string.Empty
        };
        return text.IndexOfAny([',', '"', '\r', '\n']) >= 0
            ? $"\"{text.Replace("\"", "\"\"")}\""
            : text;
    }
}
