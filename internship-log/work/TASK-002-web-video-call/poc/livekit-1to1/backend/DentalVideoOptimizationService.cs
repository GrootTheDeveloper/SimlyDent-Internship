using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;
using System.Diagnostics;

namespace LiveKitPoc.Api;

/// <summary>
/// Background H.264 CRF optimizer: Original → Playback. Never blocks End/Stop.
/// Idempotent; Original stays canonical if optimize fails.
/// </summary>
public sealed class DentalVideoOptimizationService(
    IConsultationCatalog catalog,
    IRecordingStorage storage,
    MediaProbeService probe,
    IOptions<DentalVideoOptions> options,
    ILogger<DentalVideoOptimizationService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var opt = options.Value;
        if (!opt.OptimizeEnabled)
        {
            logger.LogInformation("DentalVideoOptimizationService disabled (DENTAL_VIDEO_OPTIMIZE_ENABLED off)");
            // Still park so DI doesn't complain; idle until cancelled
            try { await Task.Delay(Timeout.Infinite, stoppingToken); }
            catch (OperationCanceledException) { /* shut down */ }
            return;
        }

        logger.LogInformation(
            "DentalVideoOptimizationService started interval={Sec}s batch={Batch} crf={Crf} preset={Preset}",
            opt.OptimizeIntervalSeconds, opt.OptimizeBatch, opt.OptimizeCrf, opt.OptimizePreset);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunBatchAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Dental optimize batch failed");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(Math.Max(10, opt.OptimizeIntervalSeconds)), stoppingToken);
            }
            catch (OperationCanceledException) { break; }
        }
    }

    private async Task RunBatchAsync(CancellationToken ct)
    {
        var opt = options.Value;
        // Scan recent Ready dental clips lacking Playback — clinic-agnostic via ListStuck is wrong.
        // Use ListSessions is heavy; instead list stuck is only active. Walk recent sessions lightly:
        // For PoC: use ListSessions per known demos is not available. Use catalog ListStuck no.
        // Query via ListSessionsByClinic for clinic-a and clinic-b is pragmatic for PoC.
        foreach (var clinic in new[] { "clinic-a", "clinic-b" })
        {
            IReadOnlyList<ConsultationSession> sessions;
            try
            {
                sessions = await catalog.ListSessionsByClinicAsync(clinic, 40, 0, ct);
            }
            catch
            {
                continue;
            }

            var done = 0;
            foreach (var session in sessions)
            {
                if (done >= opt.OptimizeBatch) break;
                IReadOnlyList<MediaAsset> assets;
                try
                {
                    assets = await catalog.ListAssetsBySessionAsync(session.Id, ct);
                }
                catch { continue; }

                foreach (var asset in assets)
                {
                    if (done >= opt.OptimizeBatch) break;
                    if (asset.Kind != MediaAssetKinds.DentalVideoClip) continue;
                    if (asset.Status != MediaAssetStatus.Ready) continue;

                    var playback = await catalog.GetObjectByAssetAndKindAsync(
                        asset.Id, MediaObjectKinds.Playback, ct);
                    if (playback?.ReadyAt is not null && playback.Bytes is > 0)
                        continue;

                    var original = await catalog.GetObjectByAssetAndKindAsync(
                        asset.Id, MediaObjectKinds.Original, ct);
                    if (original is null || string.IsNullOrWhiteSpace(original.StorageKey))
                        continue;
                    if (!await storage.ExistsAsync(original.StorageKey, ct))
                        continue;

                    try
                    {
                        var ok = await OptimizeOneAsync(asset, original, opt, ct);
                        if (ok) done++;
                    }
                    catch (Exception ex)
                    {
                        logger.LogWarning(ex, "Optimize failed asset={AssetId}", asset.Id);
                    }
                }
            }
        }
    }

    private async Task<bool> OptimizeOneAsync(
        MediaAsset asset,
        MediaObject original,
        DentalVideoOptions opt,
        CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        var inPath = Path.Combine(Path.GetTempPath(), $"in-{asset.Id:N}.mp4");
        var outPath = Path.Combine(Path.GetTempPath(), $"out-{asset.Id:N}.mp4");
        try
        {
            await using (var src = await storage.OpenReadAsync(original.StorageKey, ct))
            {
                if (src is null) return false;
                await using var fs = File.Create(inPath);
                await src.CopyToAsync(fs, ct);
            }

            var inBytes = new FileInfo(inPath).Length;
            if (inBytes <= 0) return false;

            if (!await RunFfmpegAsync(inPath, outPath, opt, ct))
                return false;

            var probeIn = await probe.ProbeFileAsync(inPath, ct);
            var probeOut = await probe.ProbeFileAsync(outPath, ct);
            if (!ValidateOptimized(probeIn, probeOut, outPath))
            {
                logger.LogWarning("Optimize validation failed asset={AssetId}", asset.Id);
                return false;
            }

            var outBytes = new FileInfo(outPath).Length;
            var playbackKey = original.StorageKey.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)
                ? original.StorageKey[..^4] + ".opt.mp4"
                : original.StorageKey + ".opt.mp4";

            await storage.SaveFromLocalFileAsync(playbackKey, outPath, ct);
            await catalog.UpsertMediaObjectAsync(
                asset.Id, MediaObjectKinds.Playback, playbackKey,
                mimeType: "video/mp4",
                bytes: outBytes,
                etag: null,
                width: probeOut.Width ?? original.Width,
                height: probeOut.Height ?? original.Height,
                durationMs: probeOut.DurationMs ?? original.DurationMs,
                bitrateKbps: probeOut.BitrateKbps,
                codec: probeOut.Codec ?? "h264",
                ct);
            await catalog.MarkMediaObjectReadyAsync(
                asset.Id, MediaObjectKinds.Playback, outBytes, null,
                probeOut.DurationMs, ct);

            sw.Stop();
            var saved = inBytes - outBytes;
            var pct = inBytes > 0 ? (100.0 * saved / inBytes) : 0;
            logger.LogInformation(
                "DentalClip optimized asset={AssetId} inBytes={In} outBytes={Out} saved={Saved} pct={Pct:F1}% elapsedMs={Ms}",
                asset.Id, inBytes, outBytes, saved, pct, sw.ElapsedMilliseconds);

            if (opt.DeleteOriginalAfterOptimize)
            {
                // Safety: only after Playback ready — still default false
                logger.LogInformation(
                    "DENTAL_VIDEO_DELETE_ORIGINAL_AFTER_OPTIMIZE set but deferred for safety asset={AssetId}",
                    asset.Id);
            }

            return true;
        }
        finally
        {
            try { File.Delete(inPath); } catch { /* ignore */ }
            try { File.Delete(outPath); } catch { /* ignore */ }
        }
    }

    private static bool ValidateOptimized(MediaProbeResult input, MediaProbeResult output, string outPath)
    {
        if (!File.Exists(outPath) || new FileInfo(outPath).Length <= 0) return false;
        if (output.Width is null or <= 0 || output.Height is null or <= 0) return false;
        if (output.Error is not null && output.Codec is null) return false;
        // Duration within 15% or 500ms
        if (input.DurationMs is > 0 && output.DurationMs is > 0)
        {
            var diff = Math.Abs(input.DurationMs.Value - output.DurationMs.Value);
            var tol = Math.Max(500, (long)(input.DurationMs.Value * 0.15));
            if (diff > tol) return false;
        }
        // No FPS increase beyond noise
        if (input.FrameRate is > 0 && output.FrameRate is > 0
            && output.FrameRate > input.FrameRate + 1.5)
            return false;
        // No upscale
        if (input.Width is > 0 && output.Width > input.Width + 2) return false;
        if (input.Height is > 0 && output.Height > input.Height + 2) return false;
        return true;
    }

    private static async Task<bool> RunFfmpegAsync(
        string input, string output, DentalVideoOptions opt, CancellationToken ct)
    {
        try
        {
            var args =
                $"-y -i \"{input}\" -an -c:v libx264 -preset {opt.OptimizePreset} " +
                $"-crf {opt.OptimizeCrf} -movflags +faststart -pix_fmt yuv420p \"{output}\"";
            using var p = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = args,
                    RedirectStandardError = true,
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            p.Start();
            await p.WaitForExitAsync(ct);
            return p.ExitCode == 0 && File.Exists(output);
        }
        catch
        {
            return false;
        }
    }
}
