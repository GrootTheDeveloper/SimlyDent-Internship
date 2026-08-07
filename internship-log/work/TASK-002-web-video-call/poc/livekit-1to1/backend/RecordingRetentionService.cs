using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// DB-driven retention: Ready → DeletePending → Deleted.
/// Deleted only after every physical object is gone or confirmed absent.
/// retention_until NULL is never auto-deleted.
/// </summary>
public sealed class RecordingRetentionService(
    IRecordingCatalog catalog,
    ConcurrentDictionary<Guid, CallSession> calls,
    IRecordingStorage storage,
    RecordingAuditService audit,
    ILogger<RecordingRetentionService> logger,
    IConsultationCatalog? consultationCatalog = null) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(25), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await RunOnceAsync(stoppingToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Recording retention sweep failed (call path unaffected).");
            }

            try
            {
                await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    public int RunOnce() =>
        RunOnceAsync(CancellationToken.None).GetAwaiter().GetResult();

    public async Task<int> RunOnceAsync(CancellationToken cancellationToken = default)
    {
        var deleted = 0;
        var due = await catalog.ListDueForRetentionAsync(50, cancellationToken);
        foreach (var row in due)
        {
            if (await ProcessRetentionCandidateAsync(row, claimFromReady: true, cancellationToken))
                deleted++;
        }

        var pending = await catalog.ListDeletePendingAsync(50, cancellationToken);
        foreach (var row in pending)
        {
            if (await ProcessRetentionCandidateAsync(row, claimFromReady: false, cancellationToken))
                deleted++;
        }

        // Media assets retention
        if (consultationCatalog is not null)
        {
            try
            {
                deleted += await ProcessMediaRetentionAsync(cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Media asset retention sweep failed.");
            }
        }

        if (deleted > 0)
            logger.LogInformation("Retention completed {Count} recording(s).", deleted);
        return deleted;
    }

    private async Task<int> ProcessMediaRetentionAsync(CancellationToken cancellationToken)
    {
        if (consultationCatalog is null) return 0;
        var deleted = 0;
        var due = await consultationCatalog.ListDueForRetentionAsync(50, cancellationToken);
        foreach (var asset in due)
        {
            if (await ProcessMediaCandidateAsync(asset, claimFromReady: true, cancellationToken))
                deleted++;
        }
        var pending = await consultationCatalog.ListDeletePendingAsync(50, cancellationToken);
        foreach (var asset in pending)
        {
            if (await ProcessMediaCandidateAsync(asset, claimFromReady: false, cancellationToken))
                deleted++;
        }
        return deleted;
    }

    private async Task<bool> ProcessMediaCandidateAsync(
        MediaAsset asset,
        bool claimFromReady,
        CancellationToken cancellationToken)
    {
        if (consultationCatalog is null) return false;
        if (claimFromReady)
        {
            var claimed = await consultationCatalog.TryMarkDeletePendingAsync(asset.Id, cancellationToken);
            if (!claimed) return false;
        }
        else if (asset.Status != MediaAssetStatus.DeletePending)
        {
            return false;
        }

        var objects = await consultationCatalog.GetObjectsByAssetAsync(asset.Id, cancellationToken);
        var allGone = true;
        foreach (var obj in objects)
        {
            try
            {
                await storage.DeleteAsync(obj.StorageKey, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Media retention delete failed for {Key}", obj.StorageKey);
                allGone = false;
                continue;
            }

            try
            {
                if (await storage.ExistsAsync(obj.StorageKey, cancellationToken))
                    allGone = false;
            }
            catch
            {
                allGone = false;
            }
        }

        if (!allGone)
        {
            audit.Append(asset.ClinicId, asset.CallId, asset.Id.ToString(), "system", "System",
                "MediaExpired", "Partial", "DeletePending retry");
            return false;
        }

        await consultationCatalog.MarkDeletedAsync(asset.Id, cancellationToken);
        audit.Append(asset.ClinicId, asset.CallId, asset.Id.ToString(), "system", "System",
            "MediaExpired", "Ok", "status=Deleted");
        return true;
    }

    private async Task<bool> ProcessRetentionCandidateAsync(
        RecordingRecord row,
        bool claimFromReady,
        CancellationToken cancellationToken)
    {
        if (claimFromReady)
        {
            var claimed = await catalog.TryMarkDeletePendingAsync(row.Id, cancellationToken);
            if (!claimed) return false;
        }
        else if (row.Status != RecordingLedgerStatus.DeletePending)
        {
            return false;
        }

        var keys = await catalog.ListObjectKeysAsync(row.Id, cancellationToken);
        if (keys.Count == 0 && !string.IsNullOrWhiteSpace(row.StorageKey))
            keys = new[] { row.StorageKey! };

        var allGone = true;
        foreach (var key in keys)
        {
            try
            {
                await storage.DeleteAsync(key, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Retention delete failed for {Key}", key);
                allGone = false;
                continue;
            }

            try
            {
                if (await storage.ExistsAsync(key, cancellationToken))
                    allGone = false;
            }
            catch
            {
                // If Exists fails after delete, treat as not confirmed.
                allGone = false;
            }
        }

        if (!allGone)
        {
            audit.Append(row.ClinicId, row.CallId, row.Id, "system", "System",
                "RecordingExpired", "Partial", "DeletePending retry");
            return false;
        }

        await catalog.MarkDeletedAsync(row.Id, cancellationToken);
        if (calls.TryGetValue(row.CallId, out var call))
        {
            lock (call.SyncRoot)
            {
                if (string.Equals(call.RecordingId, row.Id, StringComparison.OrdinalIgnoreCase)
                    || string.IsNullOrWhiteSpace(call.RecordingId))
                {
                    call.RecordingStatus = "Deleted";
                    call.RecordingStorageKey = null;
                    call.UpdatedAt = DateTimeOffset.UtcNow;
                }
            }
        }

        audit.Append(row.ClinicId, row.CallId, row.Id, "system", "System",
            "RecordingExpired", "Ok", "status=Deleted");
        return true;
    }
}
