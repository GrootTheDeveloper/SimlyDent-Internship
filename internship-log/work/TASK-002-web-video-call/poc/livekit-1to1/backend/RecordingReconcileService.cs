namespace LiveKitPoc.Api;

/// <summary>
/// Correctness path when webhook is lost or API restarts mid-Finalizing.
/// Never fails long ACTIVE Recording solely by wall-clock age.
/// </summary>
public sealed class RecordingReconcileService(
    IRecordingCatalog catalog,
    LiveKitEgressService egress,
    RecordingFinalizeService finalize,
    IConfiguration configuration,
    ILogger<RecordingReconcileService> logger,
    IConsultationCatalog? consultationCatalog = null) : BackgroundService
{
    private int IntervalSeconds =>
        int.TryParse(configuration["RECORDING_RECONCILE_SECONDS"], out var n) && n > 0 ? n : 30;

    private int BatchLimit =>
        int.TryParse(configuration["RECORDING_RECONCILE_BATCH"], out var n) && n > 0 ? n : 40;

    private int GraceSeconds =>
        int.TryParse(configuration["RECORDING_RECONCILE_GRACE_SECONDS"], out var n) && n >= 0 ? n : 10;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(15), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Recording reconcile tick failed (call path unaffected).");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(IntervalSeconds), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    public async Task<int> RunOnceAsync(CancellationToken cancellationToken = default)
    {
        var stuck = await catalog.ListStuckAsync(BatchLimit, cancellationToken);
        var handled = 0;
        foreach (var snapshot in stuck)
        {
            // Re-read before mutate (egress_id may have changed).
            var row = await catalog.GetByIdAsync(snapshot.Id, cancellationToken);
            if (row is null) continue;
            if (RecordingLedgerStatus.IsTerminal(row.Status)) continue;
            if (string.IsNullOrWhiteSpace(row.EgressId)) continue;

            if (row.Status == RecordingLedgerStatus.Finalizing)
            {
                var started = row.FinalizingStartedAt;
                if (started is not null && (DateTimeOffset.UtcNow - started.Value).TotalSeconds < GraceSeconds)
                    continue;
            }

            EgressResult? info = null;
            try
            {
                info = await egress.GetEgressStatusAsync(row.EgressId, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "ListEgress failed for {EgressId}", row.EgressId);
            }

            if (info is null)
            {
                // Cannot reach LiveKit — only apply finalizing timeout clocks, never kill ACTIVE Recording.
                if (row.Status == RecordingLedgerStatus.Finalizing)
                {
                    var r = await finalize.ApplyFinalizingTimeoutIfNeededAsync(row, cancellationToken);
                    if (r.Changed) handled++;
                }
                continue;
            }

            // Re-check egress_id correlation after network call
            var current = await catalog.GetByIdAsync(row.Id, cancellationToken);
            if (current is null) continue;
            if (!string.Equals(current.EgressId, row.EgressId, StringComparison.Ordinal))
                continue;

            var st = (info.Status ?? "").ToUpperInvariant();
            if (st.StartsWith("EGRESS_", StringComparison.Ordinal))
                st = st["EGRESS_".Length..];

            // Long Recording + ACTIVE: never timeout-fail.
            if (current.Status == RecordingLedgerStatus.Recording
                && st is "ACTIVE" or "STARTING" or "ENDING" or "")
            {
                continue;
            }

            var applied = await finalize.ApplyEgressStatusAsync(
                current.EgressId!,
                info.Status,
                info.Error,
                info.ErrorCode?.ToString(),
                cancellationToken);
            if (applied.Changed) handled++;

            if (!applied.Changed && current.Status == RecordingLedgerStatus.Finalizing)
            {
                var timed = await finalize.ApplyFinalizingTimeoutIfNeededAsync(
                    await catalog.GetByIdAsync(current.Id, cancellationToken) ?? current,
                    cancellationToken);
                if (timed.Changed) handled++;
            }
        }

        // Parallel loop for media_assets (consultation catalog)
        if (consultationCatalog is not null)
        {
            try
            {
                handled += await ReconcileMediaAssetsAsync(cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Media asset reconcile failed (recording path unaffected).");
            }
        }

        if (handled > 0)
            logger.LogInformation("Recording reconcile applied {Count} transition(s).", handled);
        return handled;
    }

    private async Task<int> ReconcileMediaAssetsAsync(CancellationToken cancellationToken)
    {
        if (consultationCatalog is null) return 0;
        var stuck = await consultationCatalog.ListStuckAssetsAsync(BatchLimit, cancellationToken);
        var handled = 0;
        foreach (var snapshot in stuck)
        {
            var asset = await consultationCatalog.GetAssetByIdAsync(snapshot.Id, cancellationToken);
            if (asset is null) continue;
            if (MediaAssetStatus.IsTerminal(asset.Status)) continue;

            // Snapshot Uploading without egress — timeout only
            if (asset.Kind == MediaAssetKinds.Snapshot && asset.Status == MediaAssetStatus.Uploading)
            {
                var age = DateTimeOffset.UtcNow - (asset.StartedAt ?? asset.RequestedAt);
                if (age.TotalSeconds >= 600)
                {
                    var failed = await consultationCatalog.TryMarkFailedAsync(
                        asset.Id, null, "Snapshot upload timeout", cancellationToken);
                    if (failed) handled++;
                }
                continue;
            }

            if (string.IsNullOrWhiteSpace(asset.EgressId)) continue;

            if (asset.Status == MediaAssetStatus.Finalizing)
            {
                var started = asset.FinalizingStartedAt;
                if (started is not null && (DateTimeOffset.UtcNow - started.Value).TotalSeconds < GraceSeconds)
                    continue;
            }

            EgressResult? info = null;
            try
            {
                info = await egress.GetEgressStatusAsync(asset.EgressId, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "ListEgress failed for media {EgressId}", asset.EgressId);
            }

            if (info is null)
            {
                if (asset.Status == MediaAssetStatus.Finalizing)
                {
                    var r = await finalize.ApplyMediaFinalizingTimeoutIfNeededAsync(asset, cancellationToken);
                    if (r.Changed) handled++;
                }
                continue;
            }

            var current = await consultationCatalog.GetAssetByIdAsync(asset.Id, cancellationToken);
            if (current is null) continue;
            if (!string.Equals(current.EgressId, asset.EgressId, StringComparison.Ordinal))
                continue;

            var st = (info.Status ?? "").ToUpperInvariant();
            if (st.StartsWith("EGRESS_", StringComparison.Ordinal))
                st = st["EGRESS_".Length..];

            if (current.Status == MediaAssetStatus.Recording
                && st is "ACTIVE" or "STARTING" or "ENDING" or "")
                continue;

            var applied = await finalize.ApplyMediaEgressStatusAsync(
                current.EgressId!,
                info.Status,
                info.Error,
                info.ErrorCode?.ToString(),
                cancellationToken);
            if (applied.Changed) handled++;

            if (!applied.Changed && current.Status == MediaAssetStatus.Finalizing)
            {
                var timed = await finalize.ApplyMediaFinalizingTimeoutIfNeededAsync(
                    await consultationCatalog.GetAssetByIdAsync(current.Id, cancellationToken) ?? current,
                    cancellationToken);
                if (timed.Changed) handled++;
            }
        }
        return handled;
    }
}
