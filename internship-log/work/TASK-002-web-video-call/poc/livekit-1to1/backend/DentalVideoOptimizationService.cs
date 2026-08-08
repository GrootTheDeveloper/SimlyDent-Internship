using System.Diagnostics;
using System.Text;
using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;

namespace LiveKitPoc.Api;

/// <summary>
/// Background H.264 CRF optimizer: Original → Playback when smaller by threshold.
/// Never blocks End/Stop. Durable catalog claim; no hardcoded clinic list.
/// </summary>
public sealed class DentalVideoOptimizationService(
    IConsultationCatalog catalog,
    IRecordingStorage storage,
    MediaProbeService probe,
    IOptions<DentalVideoOptions> options,
    ILogger<DentalVideoOptimizationService> logger) : BackgroundService
{
    private readonly string _workerId =
        $"{Environment.MachineName}-{Environment.ProcessId}-{Guid.NewGuid():N}";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var opt = options.Value;
        if (!opt.OptimizeEnabled)
        {
            logger.LogInformation("DentalVideoOptimizationService disabled (DENTAL_VIDEO_OPTIMIZE_ENABLED off)");
            try { await Task.Delay(Timeout.Infinite, stoppingToken); }
            catch (OperationCanceledException) { /* shut down */ }
            return;
        }

        logger.LogInformation(
            "DentalVideoOptimizationService started worker={Worker} interval={Sec}s batch={Batch} crf={Crf} preset={Preset} minSaving={Min}% timeout={To}s",
            _workerId, opt.OptimizeIntervalSeconds, opt.OptimizeBatch, opt.OptimizeCrf,
            opt.OptimizePreset, opt.MinSavingPercent, opt.OptimizeTimeoutSeconds);

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
        IReadOnlyList<DentalOptimizationCandidate> candidates;
        try
        {
            candidates = await catalog.ListDentalVideoOptimizationCandidatesAsync(
                opt.OptimizeBatch, opt.OptimizeMaxAttempts, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "ListDentalVideoOptimizationCandidates failed");
            return;
        }

        foreach (var c in candidates)
        {
            if (ct.IsCancellationRequested) break;

            var leaseUntil = DateTimeOffset.UtcNow.AddSeconds(opt.OptimizeLeaseSeconds);
            bool claimed;
            try
            {
                claimed = await catalog.TryClaimDentalOptimizationAsync(
                    c.AssetId, _workerId, leaseUntil, opt.OptimizeMaxAttempts, ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "TryClaimDentalOptimization failed asset={AssetId}", c.AssetId);
                continue;
            }
            if (!claimed) continue;

            try
            {
                await OptimizeClaimedAsync(c, opt, ct);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Optimize failed asset={AssetId}", c.AssetId);
                try
                {
                    await catalog.ReleaseDentalOptimizationClaimAsync(
                        c.AssetId, _workerId, permanent: false, ex.Message,
                        TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                }
                catch (Exception relEx)
                {
                    logger.LogWarning(relEx, "Release claim failed asset={AssetId}", c.AssetId);
                }
            }
        }
    }

    private async Task OptimizeClaimedAsync(
        DentalOptimizationCandidate candidate,
        DentalVideoOptions opt,
        CancellationToken ct)
    {
        var assetId = candidate.AssetId;
        // Re-read objects after claim — Original must be Ready; Playback must not already win.
        var original = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Original, ct);
        if (original is null || string.IsNullOrWhiteSpace(original.StorageKey) || original.ReadyAt is null)
        {
            await catalog.CompleteDentalOptimizationAsync(
                assetId, DentalOptimizationStatus.Skipped, "Original not ready", ct);
            return;
        }

        var playbackExisting = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Playback, ct);
        if (playbackExisting?.ReadyAt is not null && playbackExisting.Bytes is > 0)
        {
            await catalog.CompleteDentalOptimizationAsync(
                assetId, DentalOptimizationStatus.Ready, "Playback already present", ct);
            return;
        }

        if (!await storage.ExistsAsync(original.StorageKey, ct))
        {
            await catalog.ReleaseDentalOptimizationClaimAsync(
                assetId, _workerId, permanent: false, "Original object missing on storage",
                TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
            return;
        }

        var jobDir = Path.Combine(Path.GetTempPath(), $"dental-opt-{assetId:N}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(jobDir);
        var inPath = Path.Combine(jobDir, "in.mp4");
        var outPath = Path.Combine(jobDir, "out.mp4");
        var sw = Stopwatch.StartNew();

        try
        {
            await using (var src = await storage.OpenReadAsync(original.StorageKey, ct))
            {
                if (src is null)
                {
                    await catalog.ReleaseDentalOptimizationClaimAsync(
                        assetId, _workerId, permanent: false, "OpenRead Original returned null",
                        TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                    return;
                }
                await using var fs = File.Create(inPath);
                await src.CopyToAsync(fs, ct);
            }

            var inBytes = new FileInfo(inPath).Length;
            if (inBytes <= 0)
            {
                await catalog.CompleteDentalOptimizationAsync(
                    assetId, DentalOptimizationStatus.Skipped, "empty Original", ct);
                return;
            }

            if (opt.MinOriginalBytes > 0 && inBytes < opt.MinOriginalBytes)
            {
                logger.LogInformation(
                    "OptimizationSkippedTooSmall asset={AssetId} bytes={Bytes} min={Min}",
                    assetId, inBytes, opt.MinOriginalBytes);
                await catalog.CompleteDentalOptimizationAsync(
                    assetId, DentalOptimizationStatus.Skipped,
                    $"too small ({inBytes}<{opt.MinOriginalBytes})", ct);
                return;
            }

            // Optional disk guard: need ~2x input + margin
            try
            {
                var root = Path.GetPathRoot(jobDir) ?? jobDir;
                var di = new DriveInfo(root);
                var need = inBytes * 2 + 50_000_000L;
                if (di.AvailableFreeSpace < need)
                {
                    logger.LogWarning(
                        "Optimize skipped low disk asset={AssetId} free={Free} need~={Need}",
                        assetId, di.AvailableFreeSpace, need);
                    await catalog.ReleaseDentalOptimizationClaimAsync(
                        assetId, _workerId, permanent: false, "low disk space",
                        TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                    return;
                }
            }
            catch (Exception diskEx)
            {
                logger.LogDebug(diskEx, "Disk space check skipped asset={AssetId}", assetId);
            }

            var probeIn = await probe.ProbeFileAsync(inPath, ct);
            if (opt.MinDurationMs > 0 && probeIn.DurationMs is > 0 && probeIn.DurationMs < opt.MinDurationMs)
            {
                logger.LogInformation(
                    "OptimizationSkippedTooShort asset={AssetId} durationMs={Dur} min={Min}",
                    assetId, probeIn.DurationMs, opt.MinDurationMs);
                await catalog.CompleteDentalOptimizationAsync(
                    assetId, DentalOptimizationStatus.Skipped,
                    $"too short ({probeIn.DurationMs}<{opt.MinDurationMs})", ct);
                return;
            }

            var (ffmpegOk, ffmpegErr) = await RunFfmpegAsync(inPath, outPath, opt, ct);
            if (!ffmpegOk)
            {
                var permanent = IsPermanentFfmpegFailure(ffmpegErr);
                logger.LogWarning(
                    "FFmpeg optimize failed asset={AssetId} permanent={Perm} err={Err}",
                    assetId, permanent, ffmpegErr);
                if (permanent && candidate.OptimizationAttempts + 1 >= opt.OptimizeMaxAttempts)
                {
                    await catalog.ReleaseDentalOptimizationClaimAsync(
                        assetId, _workerId, permanent: true, ffmpegErr ?? "ffmpeg failed",
                        TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                }
                else
                {
                    await catalog.ReleaseDentalOptimizationClaimAsync(
                        assetId, _workerId, permanent: permanent, ffmpegErr ?? "ffmpeg failed",
                        TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                }
                return;
            }

            var probeOut = await probe.ProbeFileAsync(outPath, ct);
            if (!ValidateOptimized(probeIn, probeOut, outPath, out var validationError))
            {
                logger.LogWarning(
                    "Optimize validation failed asset={AssetId} reason={Reason}",
                    assetId, validationError);
                await catalog.ReleaseDentalOptimizationClaimAsync(
                    assetId, _workerId, permanent: true, validationError,
                    TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                return;
            }

            var outBytes = new FileInfo(outPath).Length;
            var saved = inBytes - outBytes;
            var savingPercent = inBytes > 0 ? (100.0 * saved / inBytes) : 0;

            if (outBytes <= 0 || saved <= 0 || savingPercent < opt.MinSavingPercent)
            {
                logger.LogInformation(
                    "OptimizationSkippedNoSaving asset={AssetId} inputBytes={In} outputBytes={Out} savedBytes={Saved} savingPercent={Pct:F2} threshold={Th}",
                    assetId, inBytes, outBytes, saved, savingPercent, opt.MinSavingPercent);
                try { if (File.Exists(outPath)) File.Delete(outPath); } catch { /* ignore */ }
                await catalog.CompleteDentalOptimizationAsync(
                    assetId, DentalOptimizationStatus.Skipped,
                    $"no saving in={inBytes} out={outBytes} pct={savingPercent:F2}", ct);
                return;
            }

            var playbackKey = original.StorageKey.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)
                ? original.StorageKey[..^4] + ".opt.mp4"
                : original.StorageKey + ".opt.mp4";

            try
            {
                await storage.SaveFromLocalFileAsync(playbackKey, outPath, ct);
            }
            catch (Exception upEx)
            {
                logger.LogWarning(upEx, "Playback upload failed asset={AssetId}", assetId);
                await catalog.ReleaseDentalOptimizationClaimAsync(
                    assetId, _workerId, permanent: false, "upload: " + upEx.Message,
                    TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                return;
            }

            if (!await storage.ExistsAsync(playbackKey, ct))
            {
                await catalog.ReleaseDentalOptimizationClaimAsync(
                    assetId, _workerId, permanent: false, "Playback missing after upload",
                    TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                return;
            }

            try
            {
                await catalog.UpsertMediaObjectAsync(
                    assetId, MediaObjectKinds.Playback, playbackKey,
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
                    assetId, MediaObjectKinds.Playback, outBytes, null,
                    probeOut.DurationMs, ct);
            }
            catch (Exception catEx)
            {
                logger.LogWarning(catEx, "Playback catalog persist failed asset={AssetId}", assetId);
                try { await storage.DeleteAsync(playbackKey, ct); } catch { /* best effort */ }
                await catalog.ReleaseDentalOptimizationClaimAsync(
                    assetId, _workerId, permanent: false, "catalog: " + catEx.Message,
                    TimeSpan.FromSeconds(opt.OptimizeRetryBackoffSeconds), ct);
                return;
            }

            // Re-read Playback before optional Original delete
            var playbackReady = await catalog.GetObjectByAssetAndKindAsync(
                assetId, MediaObjectKinds.Playback, ct);
            if (playbackReady?.ReadyAt is null
                || playbackReady.Bytes is null or <= 0
                || string.IsNullOrWhiteSpace(playbackReady.StorageKey)
                || !await storage.ExistsAsync(playbackReady.StorageKey, ct))
            {
                logger.LogWarning(
                    "Playback verify failed after promote asset={AssetId} — keeping Original",
                    assetId);
                await catalog.CompleteDentalOptimizationAsync(
                    assetId, DentalOptimizationStatus.Ready,
                    "Playback catalog incomplete; Original retained", ct);
                return;
            }

            sw.Stop();
            logger.LogInformation(
                "DentalClip optimized asset={AssetId} clinic={Clinic} inBytes={In} outBytes={Out} savedBytes={Saved} savingPercent={Pct:F1}% elapsedMs={Ms}",
                assetId, candidate.ClinicId, inBytes, outBytes, saved, savingPercent, sw.ElapsedMilliseconds);

            if (opt.DeleteOriginalAfterOptimize)
            {
                await TryDeleteOriginalAfterPlaybackAsync(assetId, original, playbackReady, ct);
            }

            await catalog.CompleteDentalOptimizationAsync(
                assetId, DentalOptimizationStatus.Ready, null, ct);
        }
        finally
        {
            try
            {
                if (Directory.Exists(jobDir))
                    Directory.Delete(jobDir, recursive: true);
            }
            catch { /* ignore */ }
        }
    }

    private async Task TryDeleteOriginalAfterPlaybackAsync(
        Guid assetId,
        MediaObject original,
        MediaObject playback,
        CancellationToken ct)
    {
        // Strict ordering: Playback uploaded + ReadyAt + exists + re-read catalog.
        if (playback.ReadyAt is null || playback.Bytes is null or <= 0)
        {
            logger.LogWarning("DeleteOriginal skipped — Playback not verified asset={AssetId}", assetId);
            return;
        }
        if (!await storage.ExistsAsync(playback.StorageKey, ct))
        {
            logger.LogWarning("DeleteOriginal skipped — Playback physical missing asset={AssetId}", assetId);
            return;
        }

        // Re-read again immediately before delete (write-race guard)
        var again = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Playback, ct);
        if (again?.ReadyAt is null || again.Bytes is null or <= 0
            || !string.Equals(again.StorageKey, playback.StorageKey, StringComparison.Ordinal))
        {
            logger.LogWarning("DeleteOriginal skipped — Playback re-read race asset={AssetId}", assetId);
            return;
        }

        try
        {
            await storage.DeleteAsync(original.StorageKey, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "DeleteOriginal physical failed asset={AssetId} key={Key}",
                assetId, original.StorageKey);
            return;
        }

        // Confirm gone (or treat missing as success)
        var stillThere = false;
        try { stillThere = await storage.ExistsAsync(original.StorageKey, ct); }
        catch { stillThere = true; }

        if (stillThere)
        {
            logger.LogWarning("DeleteOriginal still exists after DeleteAsync asset={AssetId}", assetId);
            return;
        }

        try
        {
            await catalog.RemoveMediaObjectAsync(assetId, MediaObjectKinds.Original, ct);
            logger.LogInformation(
                "Original deleted after optimize asset={AssetId} key={Key}",
                assetId, original.StorageKey);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "RemoveMediaObject Original failed after physical delete asset={AssetId}", assetId);
        }
    }

    public static bool ValidateOptimized(
        MediaProbeResult input,
        MediaProbeResult output,
        string outPath,
        out string? error)
    {
        error = null;
        if (!File.Exists(outPath) || new FileInfo(outPath).Length <= 0)
        {
            error = "output missing or empty";
            return false;
        }
        if (output.Error is not null && output.Codec is null)
        {
            error = "ffprobe fatal: " + output.Error;
            return false;
        }
        if (output.Width is null or <= 0 || output.Height is null or <= 0)
        {
            error = "missing output resolution";
            return false;
        }
        if (output.Codec is not null
            && !output.Codec.Contains("264", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(output.Codec, "h264", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(output.Codec, "avc1", StringComparison.OrdinalIgnoreCase))
        {
            error = "output codec not h264: " + output.Codec;
            return false;
        }
        if (input.DurationMs is > 0 && output.DurationMs is > 0)
        {
            var diff = Math.Abs(input.DurationMs.Value - output.DurationMs.Value);
            var tol = Math.Max(500, (long)(input.DurationMs.Value * 0.15));
            if (diff > tol)
            {
                error = $"duration drift {diff}ms > {tol}ms";
                return false;
            }
        }
        if (input.FrameRate is > 0 && output.FrameRate is > 0
            && output.FrameRate > input.FrameRate + 1.5)
        {
            error = "fps increased";
            return false;
        }
        if (input.Width is > 0 && output.Width > input.Width + 2)
        {
            error = "width upscale";
            return false;
        }
        if (input.Height is > 0 && output.Height > input.Height + 2)
        {
            error = "height upscale";
            return false;
        }
        return true;
    }

    private static bool IsPermanentFfmpegFailure(string? err)
    {
        if (string.IsNullOrWhiteSpace(err)) return false;
        var e = err.ToLowerInvariant();
        return e.Contains("invalid data")
               || e.Contains("moov atom not found")
               || e.Contains("does not contain any stream")
               || e.Contains("invalid argument")
               || e.Contains("unknown encoder");
    }

    private async Task<(bool ok, string? error)> RunFfmpegAsync(
        string input, string output, DentalVideoOptions opt, CancellationToken ct)
    {
        var preset = opt.OptimizePreset.Trim();
        if (!DentalVideoOptions.AllowedOptimizePresets.Contains(preset))
            return (false, "invalid preset: " + preset);

        try
        {
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
            linked.CancelAfter(TimeSpan.FromSeconds(opt.OptimizeTimeoutSeconds));

            using var p = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    RedirectStandardError = true,
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                }
            };
            // ArgumentList — no string interpolation quoting
            foreach (var a in new[]
                     {
                         "-y", "-i", input,
                         "-an",
                         "-c:v", "libx264",
                         "-preset", preset,
                         "-crf", opt.OptimizeCrf.ToString(System.Globalization.CultureInfo.InvariantCulture),
                         "-movflags", "+faststart",
                         "-pix_fmt", "yuv420p",
                         output
                     })
            {
                p.StartInfo.ArgumentList.Add(a);
            }

            var stderr = new StringBuilder(capacity: 512);
            p.ErrorDataReceived += (_, e) =>
            {
                if (e.Data is null || stderr.Length > 8000) return;
                stderr.AppendLine(e.Data);
            };

            p.Start();
            p.BeginErrorReadLine();
            // Drain stdout so full pipe cannot block ffmpeg
            var stdoutTask = p.StandardOutput.ReadToEndAsync(linked.Token);

            try
            {
                await p.WaitForExitAsync(linked.Token);
                try { await stdoutTask; } catch { /* ignore */ }
            }
            catch (OperationCanceledException)
            {
                try
                {
                    if (!p.HasExited)
                        p.Kill(entireProcessTree: true);
                }
                catch (Exception killEx)
                {
                    logger.LogDebug(killEx, "ffmpeg kill after timeout");
                }
                return (false, "ffmpeg timeout after " + opt.OptimizeTimeoutSeconds + "s");
            }

            if (p.ExitCode != 0)
                return (false, "ffmpeg exit " + p.ExitCode + ": " + Trim(stderr.ToString(), 500));
            if (!File.Exists(output) || new FileInfo(output).Length <= 0)
                return (false, "ffmpeg produced empty output");
            return (true, null);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "ffmpeg process error");
            return (false, ex.Message);
        }
    }

    private static string Trim(string s, int max) =>
        s.Length <= max ? s : s[..max];
}
