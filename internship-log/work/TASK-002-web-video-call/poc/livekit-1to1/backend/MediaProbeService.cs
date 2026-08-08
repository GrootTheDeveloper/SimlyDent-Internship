using System.Diagnostics;
using System.Text;
using System.Text.Json;
using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;

namespace LiveKitPoc.Api;

public sealed record MediaProbeResult(
    long? Bytes,
    int? Width,
    int? Height,
    long? DurationMs,
    int? BitrateKbps,
    string? Codec,
    double? FrameRate,
    string? Error);

/// <summary>
/// Optional ffprobe abstraction. Probe failure never fails recording finalize.
/// </summary>
public sealed class MediaProbeService(
    ILogger<MediaProbeService> logger,
    IOptions<DentalVideoOptions>? dentalOptions = null)
{
    private readonly object _availLock = new();
    private bool? _available;
    private DateTimeOffset _availableCheckedAt = DateTimeOffset.MinValue;
    private static readonly TimeSpan AvailabilityTtl = TimeSpan.FromMinutes(5);

    private int ProbeTimeoutSeconds =>
        Math.Clamp(dentalOptions?.Value.ProbeTimeoutSeconds ?? 15, 2, 120);

    public bool IsAvailable()
    {
        lock (_availLock)
        {
            if (_available is not null
                && DateTimeOffset.UtcNow - _availableCheckedAt < AvailabilityTtl)
                return _available.Value;
        }

        var ok = ProbeVersionOnce();
        lock (_availLock)
        {
            _available = ok;
            _availableCheckedAt = DateTimeOffset.UtcNow;
            return ok;
        }
    }

    /// <summary>Force re-check (tests).</summary>
    public void InvalidateAvailabilityCache()
    {
        lock (_availLock)
        {
            _available = null;
            _availableCheckedAt = DateTimeOffset.MinValue;
        }
    }

    private bool ProbeVersionOnce()
    {
        try
        {
            using var p = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ffprobe",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            p.StartInfo.ArgumentList.Add("-version");
            p.Start();
            if (!p.WaitForExit(3000))
            {
                try { p.Kill(entireProcessTree: true); } catch { /* ignore */ }
                return false;
            }
            return p.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    public async Task<MediaProbeResult> ProbeFileAsync(string path, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            return new MediaProbeResult(null, null, null, null, null, null, null, "file missing");

        long? bytes = null;
        try { bytes = new FileInfo(path).Length; } catch { /* ignore */ }

        if (!IsAvailable())
            return new MediaProbeResult(bytes, null, null, null, null, null, null, "ffprobe unavailable");

        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linked.CancelAfter(TimeSpan.FromSeconds(ProbeTimeoutSeconds));

            using var p = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ffprobe",
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            // ArgumentList avoids quoting/path injection issues
            p.StartInfo.ArgumentList.Add("-v");
            p.StartInfo.ArgumentList.Add("quiet");
            p.StartInfo.ArgumentList.Add("-print_format");
            p.StartInfo.ArgumentList.Add("json");
            p.StartInfo.ArgumentList.Add("-show_format");
            p.StartInfo.ArgumentList.Add("-show_streams");
            p.StartInfo.ArgumentList.Add(path);

            var stderr = new StringBuilder(capacity: 256);
            p.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is null || stderr.Length > 4000) return;
                stderr.AppendLine(e.Data);
            };

            p.Start();
            p.BeginErrorReadLine();
            var stdoutTask = p.StandardOutput.ReadToEndAsync(linked.Token);

            try
            {
                await p.WaitForExitAsync(linked.Token);
            }
            catch (OperationCanceledException)
            {
                try
                {
                    if (!p.HasExited)
                        p.Kill(entireProcessTree: true);
                }
                catch { /* ignore */ }
                logger.LogWarning("ffprobe timeout path={Path} timeoutSec={Sec}", path, ProbeTimeoutSeconds);
                return new MediaProbeResult(bytes, null, null, null, null, null, null, "ffprobe timeout");
            }

            var json = await stdoutTask;
            if (p.ExitCode != 0)
                return new MediaProbeResult(bytes, null, null, null, null, null, null,
                    "ffprobe exit " + p.ExitCode);

            return ParseFfprobeJson(json, bytes);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "ffprobe failed for {Path}", path);
            return new MediaProbeResult(bytes, null, null, null, null, null, null, ex.Message);
        }
    }

    /// <summary>Unit-testable JSON parser.</summary>
    public static MediaProbeResult ParseFfprobeJson(string json, long? fileBytes = null)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            int? w = null, h = null, br = null;
            long? durMs = null;
            string? codec = null;
            double? fps = null;

            if (root.TryGetProperty("streams", out var streams)
                && streams.ValueKind == JsonValueKind.Array)
            {
                foreach (var s in streams.EnumerateArray())
                {
                    var type = s.TryGetProperty("codec_type", out var ct) ? ct.GetString() : null;
                    if (!string.Equals(type, "video", StringComparison.OrdinalIgnoreCase))
                        continue;
                    if (s.TryGetProperty("width", out var ww) && ww.TryGetInt32(out var wi)) w = wi;
                    if (s.TryGetProperty("height", out var hh) && hh.TryGetInt32(out var hi)) h = hi;
                    if (s.TryGetProperty("codec_name", out var cn)) codec = cn.GetString();
                    if (s.TryGetProperty("avg_frame_rate", out var afr))
                        fps = ParseFraction(afr.GetString());
                    else if (s.TryGetProperty("r_frame_rate", out var rfr))
                        fps = ParseFraction(rfr.GetString());
                    if (s.TryGetProperty("bit_rate", out var sbr)
                        && long.TryParse(sbr.GetString(), out var sbrv) && sbrv > 0)
                        br = (int)Math.Round(sbrv / 1000.0);
                    break;
                }
            }

            if (root.TryGetProperty("format", out var fmt))
            {
                if (fmt.TryGetProperty("duration", out var d)
                    && double.TryParse(d.GetString(), System.Globalization.NumberStyles.Float,
                        System.Globalization.CultureInfo.InvariantCulture, out var sec) && sec > 0)
                    durMs = (long)Math.Round(sec * 1000);
                if (br is null
                    && fmt.TryGetProperty("bit_rate", out var fbr)
                    && long.TryParse(fbr.GetString(), out var fbrv) && fbrv > 0)
                    br = (int)Math.Round(fbrv / 1000.0);
                if (fileBytes is null
                    && fmt.TryGetProperty("size", out var sz)
                    && long.TryParse(sz.GetString(), out var szv))
                    fileBytes = szv;
            }

            return new MediaProbeResult(fileBytes, w, h, durMs, br, codec, fps, null);
        }
        catch (Exception ex)
        {
            return new MediaProbeResult(fileBytes, null, null, null, null, null, null, ex.Message);
        }
    }

    private static double? ParseFraction(string? frac)
    {
        if (string.IsNullOrWhiteSpace(frac) || frac == "0/0") return null;
        var parts = frac.Split('/');
        if (parts.Length == 2
            && double.TryParse(parts[0], System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var n)
            && double.TryParse(parts[1], System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var d)
            && d > 0)
            return n / d;
        if (double.TryParse(frac, System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var v))
            return v;
        return null;
    }
}
