using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

public sealed record FinalizeApplyResult(bool Changed, string? NewStatus, string? Detail);

/// <summary>
/// Tri-state: Found distinguishes "unknown egress" from "no change needed".
/// Prevents incorrect fallback to old recording catalog when webhook hits a terminal asset.
/// </summary>
public sealed record FinalizeMediaResult(bool Found, bool Changed, string? NewStatus, string? Detail);

/// <summary>
/// Shared finalize path for webhook + reconcile.
/// Ready only after object exists. Transport StopEgress is never the source of truth.
/// </summary>
public sealed class RecordingFinalizeService(
    IRecordingCatalog catalog,
    IRecordingStorage storage,
    LiveKitEgressService egress,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher,
    RecordingAuditService audit,
    IConfiguration configuration,
    ILogger<RecordingFinalizeService> logger,
    IConsultationCatalog? consultationCatalog = null)
{
    private int FinalizeTimeoutSeconds =>
        int.TryParse(configuration["RECORDING_FINALIZE_TIMEOUT_SECONDS"], out var n) && n > 0 ? n : 300;

    /// <summary>
    /// Apply terminal (or terminal-like) egress status for a known egress_id.
    /// Idempotent: Ready/Failed already → no-op.
    /// </summary>
    public async Task<FinalizeApplyResult> ApplyEgressStatusAsync(
        string egressId,
        string? egressStatus,
        string? error = null,
        string? errorCode = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(egressId))
            return new FinalizeApplyResult(false, null, "missing egress_id");

        var row = await catalog.GetByEgressIdAsync(egressId, cancellationToken);
        if (row is null)
            return new FinalizeApplyResult(false, null, "unknown egress");

        if (RecordingLedgerStatus.IsTerminal(row.Status))
            return new FinalizeApplyResult(false, row.Status, "already terminal");

        var status = (egressStatus ?? "").ToUpperInvariant();
        // Normalize LiveKit enum strings.
        if (status.StartsWith("EGRESS_", StringComparison.Ordinal))
            status = status["EGRESS_".Length..];

        if (status is "FAILED" or "ABORTED")
        {
            var msg = string.IsNullOrWhiteSpace(error)
                ? (errorCode ?? status)
                : error;
            var failed = await catalog.TryMarkFailedAsync(row.Id, egressId, msg!, cancellationToken);
            if (failed)
            {
                await DualWriteCallAsync(row, "Failed", storageKey: null, cancellationToken);
                audit.Append(row.ClinicId, row.CallId, row.Id, "system", "System",
                    "RecordingFinalizeFailed", "Failed", msg);
            }
            return new FinalizeApplyResult(failed, failed ? RecordingLedgerStatus.Failed : row.Status, msg);
        }

        if (status is "COMPLETE" or "LIMIT_REACHED")
        {
            await catalog.TrySetTerminalSeenAsync(row.Id, egressId, cancellationToken);
            // Reload clocks
            row = await catalog.GetByEgressIdAsync(egressId, cancellationToken) ?? row;

            var key = row.StorageKey
                      ?? storage.BuildKey(row.ClinicId, row.CallId, row.Id, "mp4");
            var objectOk = await EnsureObjectExistsAsync(row, key, cancellationToken);
            if (objectOk)
            {
                string? reason = status is "LIMIT_REACHED"
                    ? RecordingLedgerStatus.CompletionLimitReached
                    : null;
                var ready = await catalog.TryMarkReadyAsync(
                    row.Id, egressId, key, completionReason: reason, cancellationToken: cancellationToken);
                if (ready)
                {
                    await DualWriteCallAsync(row, "Complete", key, cancellationToken);
                    audit.Append(row.ClinicId, row.CallId, row.Id, "system", "System",
                        "RecordingStopped", "Ok", reason ?? status);
                }
                return new FinalizeApplyResult(ready, ready ? RecordingLedgerStatus.Ready : row.Status, reason ?? status);
            }

            // Object not visible yet — age from terminal_seen_at (not updated_at).
            var terminalAt = row.TerminalSeenAt ?? DateTimeOffset.UtcNow;
            var age = DateTimeOffset.UtcNow - terminalAt;
            if (age.TotalSeconds >= FinalizeTimeoutSeconds)
            {
                var failMsg = $"Object not available within {FinalizeTimeoutSeconds}s after {status}";
                var failed = await catalog.TryMarkFailedAsync(row.Id, egressId, failMsg, cancellationToken);
                if (failed)
                {
                    await DualWriteCallAsync(row, "Failed", null, cancellationToken);
                    audit.Append(row.ClinicId, row.CallId, row.Id, "system", "System",
                        "RecordingFinalizeFailed", "Failed", failMsg);
                }
                return new FinalizeApplyResult(failed, failed ? RecordingLedgerStatus.Failed : row.Status, failMsg);
            }

            logger.LogInformation(
                "Recording {RecordingId} egress {EgressId} terminal {Status} but object missing; waiting ({Age:0}s/{Timeout}s)",
                row.Id, egressId, status, age.TotalSeconds, FinalizeTimeoutSeconds);
            return new FinalizeApplyResult(false, row.Status, "object_not_visible_yet");
        }

        // ACTIVE / STARTING / ENDING etc. — no catalog change
        return new FinalizeApplyResult(false, row.Status, status);
    }

    /// <summary>
    /// Apply egress terminal status against media_assets catalog.
    /// </summary>
    public async Task<FinalizeMediaResult> ApplyMediaEgressStatusAsync(
        string egressId,
        string? egressStatus,
        string? error = null,
        string? errorCode = null,
        CancellationToken cancellationToken = default)
    {
        if (consultationCatalog is null || string.IsNullOrWhiteSpace(egressId))
            return new FinalizeMediaResult(Found: false, Changed: false, null, "unavailable");

        var asset = await consultationCatalog.GetAssetByEgressIdAsync(egressId, cancellationToken);
        if (asset is null)
            return new FinalizeMediaResult(Found: false, Changed: false, null, "unknown_egress");

        if (MediaAssetStatus.IsTerminal(asset.Status))
            return new FinalizeMediaResult(Found: true, Changed: false, asset.Status, "already_terminal");

        var status = (egressStatus ?? "").ToUpperInvariant();
        if (status.StartsWith("EGRESS_", StringComparison.Ordinal))
            status = status["EGRESS_".Length..];

        if (status is "FAILED" or "ABORTED")
        {
            var msg = string.IsNullOrWhiteSpace(error) ? (errorCode ?? status) : error;
            var failed = await consultationCatalog.TryMarkFailedAsync(asset.Id, egressId, msg!, cancellationToken);
            if (failed)
            {
                DualWriteMediaCall(asset, failedStatus: true);
                audit.Append(asset.ClinicId, asset.CallId, asset.Id.ToString(), "system", "System",
                    "MediaFinalizeFailed", "Failed", msg);
            }
            return new FinalizeMediaResult(true, failed, failed ? MediaAssetStatus.Failed : asset.Status, msg);
        }

        if (status is "COMPLETE" or "LIMIT_REACHED")
        {
            await consultationCatalog.TrySetTerminalSeenAsync(asset.Id, egressId, cancellationToken);
            asset = await consultationCatalog.GetAssetByEgressIdAsync(egressId, cancellationToken) ?? asset;

            var obj = await consultationCatalog.GetObjectByAssetAndKindAsync(
                asset.Id, MediaObjectKinds.Original, cancellationToken);
            var key = obj?.StorageKey;
            if (string.IsNullOrWhiteSpace(key))
            {
                key = asset.Kind == MediaAssetKinds.CallAudio
                    ? MediaStorageKeys.AudioKey(asset.ClinicId, asset.CallId, asset.Id)
                    : MediaStorageKeys.VideoClipKey(asset.ClinicId, asset.CallId, asset.Id);
            }

            var objectOk = await EnsureMediaObjectExistsAsync(asset, key!, cancellationToken);
            if (objectOk)
            {
                var endedAt = DateTimeOffset.UtcNow;
                var ready = await consultationCatalog.TryMarkReadyAsync(
                    asset.Id, egressId, durationMs: null, endedAt, cancellationToken);
                if (ready)
                {
                    await consultationCatalog.MarkMediaObjectReadyAsync(
                        asset.Id, MediaObjectKinds.Original, null, null, null, cancellationToken);
                    DualWriteMediaCall(asset, failedStatus: false);
                    audit.Append(asset.ClinicId, asset.CallId, asset.Id.ToString(), "system", "System",
                        "MediaReady", "Ok", status);
                }
                return new FinalizeMediaResult(true, ready,
                    ready ? MediaAssetStatus.Ready : asset.Status, status);
            }

            var terminalAt = asset.TerminalSeenAt ?? DateTimeOffset.UtcNow;
            var age = DateTimeOffset.UtcNow - terminalAt;
            if (age.TotalSeconds >= FinalizeTimeoutSeconds)
            {
                var failMsg = $"Object not available within {FinalizeTimeoutSeconds}s after {status}";
                var failed = await consultationCatalog.TryMarkFailedAsync(
                    asset.Id, egressId, failMsg, cancellationToken);
                if (failed)
                {
                    DualWriteMediaCall(asset, failedStatus: true);
                    audit.Append(asset.ClinicId, asset.CallId, asset.Id.ToString(), "system", "System",
                        "MediaFinalizeFailed", "Failed", failMsg);
                }
                return new FinalizeMediaResult(true, failed,
                    failed ? MediaAssetStatus.Failed : asset.Status, failMsg);
            }

            logger.LogInformation(
                "Media asset {AssetId} egress {EgressId} terminal {Status} but object missing; waiting",
                asset.Id, egressId, status);
            return new FinalizeMediaResult(true, false, asset.Status, "object_not_visible_yet");
        }

        return new FinalizeMediaResult(true, false, asset.Status, status);
    }

    public async Task<FinalizeMediaResult> ApplyMediaFinalizingTimeoutIfNeededAsync(
        MediaAsset asset,
        CancellationToken cancellationToken = default)
    {
        if (consultationCatalog is null)
            return new FinalizeMediaResult(false, false, null, "unavailable");
        if (asset.Status != MediaAssetStatus.Finalizing)
            return new FinalizeMediaResult(true, false, asset.Status, "not finalizing");
        if (string.IsNullOrWhiteSpace(asset.EgressId))
            return new FinalizeMediaResult(true, false, asset.Status, "no egress");

        var clock = asset.TerminalSeenAt ?? asset.FinalizingStartedAt;
        if (clock is null)
            return new FinalizeMediaResult(true, false, asset.Status, "no clock");

        var age = DateTimeOffset.UtcNow - clock.Value;
        if (age.TotalSeconds < FinalizeTimeoutSeconds)
            return new FinalizeMediaResult(true, false, asset.Status, "within timeout");

        var failMsg = $"Media finalize timeout after {FinalizeTimeoutSeconds}s";
        var failed = await consultationCatalog.TryMarkFailedAsync(
            asset.Id, asset.EgressId, failMsg, cancellationToken);
        if (failed)
        {
            DualWriteMediaCall(asset, failedStatus: true);
            audit.Append(asset.ClinicId, asset.CallId, asset.Id.ToString(), "system", "System",
                "MediaFinalizeFailed", "Failed", failMsg);
        }
        return new FinalizeMediaResult(true, failed,
            failed ? MediaAssetStatus.Failed : asset.Status, failMsg);
    }

    private async Task<bool> EnsureMediaObjectExistsAsync(
        MediaAsset asset,
        string storageKey,
        CancellationToken cancellationToken)
    {
        if (await storage.ExistsAsync(storageKey, cancellationToken))
            return true;

        if (egress.UsesDirectS3Output)
            return false;

        // Local lab: materialize from egress /out using basename of storage key
        var fileName = Path.GetFileName(storageKey);
        if (string.IsNullOrWhiteSpace(fileName))
            return false;
        var localPath = egress.GetLocalEgressPath(fileName);
        // Also try common egress naming patterns used at start
        if (!File.Exists(localPath))
        {
            var alt = asset.Kind == MediaAssetKinds.CallAudio
                ? $"audio-{asset.ClinicId}-{asset.CallId:N}-{asset.Id:N}.mp3"
                : $"clip-{asset.CallId:N}-{asset.Id:N}.mp4";
            localPath = egress.GetLocalEgressPath(alt);
        }
        if (!File.Exists(localPath))
            return false;
        try
        {
            await storage.SaveFromLocalFileAsync(storageKey, localPath, cancellationToken);
            return await storage.ExistsAsync(storageKey, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Local media materialize failed for {Key}", storageKey);
            return false;
        }
    }

    private void DualWriteMediaCall(MediaAsset asset, bool failedStatus)
    {
        if (!calls.TryGetValue(asset.CallId, out var call)) return;
        lock (call.SyncRoot)
        {
            if (asset.Kind == MediaAssetKinds.CallAudio)
            {
                call.AutoAudioStatus = failedStatus ? "Failed" : "Ready";
            }
            else if (asset.Kind == MediaAssetKinds.DentalVideoClip)
            {
                if (call.ActiveDentalClipAssetId == asset.Id || call.ActiveDentalClipAssetId is null)
                {
                    call.ActiveDentalClipStatus = failedStatus ? "Idle" : "Idle";
                    if (!failedStatus || call.ActiveDentalClipAssetId == asset.Id)
                        call.ActiveDentalClipAssetId = null;
                }
            }
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        try { _ = dispatcher.NotifyCallAsync(call); }
        catch { /* best effort */ }
    }

    /// <summary>
    /// Timeout Finalizing without terminal after finalizing_started_at age (stop accepted, egress never terminal).
    /// Never applies to status=Recording while egress is still ACTIVE (caller must check).
    /// </summary>
    public async Task<FinalizeApplyResult> ApplyFinalizingTimeoutIfNeededAsync(
        RecordingRecord row,
        CancellationToken cancellationToken = default)
    {
        if (row.Status != RecordingLedgerStatus.Finalizing)
            return new FinalizeApplyResult(false, row.Status, "not finalizing");
        if (string.IsNullOrWhiteSpace(row.EgressId))
            return new FinalizeApplyResult(false, row.Status, "no egress");

        // Prefer terminal_seen_at if set; else finalizing_started_at
        var clock = row.TerminalSeenAt ?? row.FinalizingStartedAt;
        if (clock is null)
            return new FinalizeApplyResult(false, row.Status, "no clock");

        var age = DateTimeOffset.UtcNow - clock.Value;
        if (age.TotalSeconds < FinalizeTimeoutSeconds)
            return new FinalizeApplyResult(false, row.Status, "within timeout");

        var failMsg = $"Finalize timeout after {FinalizeTimeoutSeconds}s (clock={clock:o})";
        var failed = await catalog.TryMarkFailedAsync(row.Id, row.EgressId, failMsg, cancellationToken);
        if (failed)
        {
            await DualWriteCallAsync(row, "Failed", null, cancellationToken);
            audit.Append(row.ClinicId, row.CallId, row.Id, "system", "System",
                "RecordingFinalizeFailed", "Failed", failMsg);
        }
        return new FinalizeApplyResult(failed, failed ? RecordingLedgerStatus.Failed : row.Status, failMsg);
    }

    private async Task<bool> EnsureObjectExistsAsync(
        RecordingRecord row,
        string storageKey,
        CancellationToken cancellationToken)
    {
        if (await storage.ExistsAsync(storageKey, cancellationToken))
            return true;

        if (egress.UsesDirectS3Output)
            return false;

        // Local lab: materialize from egress /out into storage root once.
        var fileName = row.FileName;
        if (string.IsNullOrWhiteSpace(fileName))
            return false;
        var localPath = egress.GetLocalEgressPath(fileName);
        if (!File.Exists(localPath))
            return false;
        try
        {
            await storage.SaveFromLocalFileAsync(storageKey, localPath, cancellationToken);
            return await storage.ExistsAsync(storageKey, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Local materialize failed for {Key}", storageKey);
            return false;
        }
    }

    private async Task DualWriteCallAsync(
        RecordingRecord row,
        string uiStatus,
        string? storageKey,
        CancellationToken cancellationToken)
    {
        if (!calls.TryGetValue(row.CallId, out var call))
            return;
        lock (call.SyncRoot)
        {
            if (!string.Equals(call.RecordingId, row.Id, StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrWhiteSpace(call.RecordingId))
            {
                // Different recording id on call — still update if egress matches
                if (!string.Equals(call.RecordingEgressId, row.EgressId, StringComparison.Ordinal))
                    return;
            }
            call.RecordingId = row.Id;
            call.RecordingStatus = uiStatus;
            call.RecordingStorageKey = storageKey;
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        try { await dispatcher.NotifyCallAsync(call); }
        catch (Exception ex) { logger.LogDebug(ex, "NotifyCall after finalize failed"); }
    }
}
