using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Shared end path for staff + embed visitor.
/// Dental TrackComposite clips need a graceful barrier: StopEgress + wait Egress terminal
/// BEFORE business End + participant disconnect. Asset Ready is NOT the barrier.
/// </summary>
public sealed class CallEndService(
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher,
    LiveKitEgressService egress,
    IRecordingCatalog catalog,
    RecordingAuditService audit,
    IConsultationCatalog consultationCatalog,
    DentalClipService clipService,
    ILogger<CallEndService> logger,
    ConsultationMediaLifecycleService? mediaLifecycle = null,
    IConfiguration? configuration = null)
{
    private static readonly ConcurrentDictionary<Guid, byte> GraceLoops = new();

    /// <summary>Soft UI grace before offering force-end (seconds). Env: GRACEFUL_END_GRACE_SECONDS</summary>
    public static int GraceSeconds { get; private set; } = 12;

    /// <summary>Hard upper bound before auto-complete End (seconds). Env: GRACEFUL_END_HARD_TIMEOUT_SECONDS</summary>
    public static int HardTimeoutSeconds { get; private set; } = 45;

    /// <summary>Max time the End HTTP request will wait for fast path (seconds). Env: GRACEFUL_END_INLINE_WAIT_SECONDS</summary>
    public static int InlineWaitSeconds { get; private set; } = 10;

    private void RefreshTimeouts()
    {
        if (int.TryParse(configuration?["GRACEFUL_END_GRACE_SECONDS"], out var g) && g > 0)
            GraceSeconds = Math.Clamp(g, 3, 120);
        if (int.TryParse(configuration?["GRACEFUL_END_HARD_TIMEOUT_SECONDS"], out var h) && h > 0)
            HardTimeoutSeconds = Math.Clamp(h, GraceSeconds, 180);
        if (int.TryParse(configuration?["GRACEFUL_END_INLINE_WAIT_SECONDS"], out var i) && i > 0)
            InlineWaitSeconds = Math.Clamp(i, 1, 30);
    }

    public Task<CallTransitionResult> EndWithRecordingAsync(
        Guid callId,
        TestIdentity actor,
        CancellationToken cancellationToken = default) =>
        EndWithRecordingAsync(callId, actor, force: false, cancellationToken);

    public async Task<CallTransitionResult> EndWithRecordingAsync(
        Guid callId,
        TestIdentity actor,
        bool force,
        CancellationToken cancellationToken = default)
    {
        RefreshTimeouts();

        if (!calls.TryGetValue(callId, out var call))
            return CallTransitionResult.NotFound();
        if (!call.BelongsToClinic(actor.ClinicId) || !call.Contains(actor.Id))
            return CallTransitionResult.NotFound();

        lock (call.SyncRoot)
        {
            if (call.Status == CallStatus.Ended)
                return CallTransitionResult.Ok(call);
            if (call.Status != CallStatus.Accepted)
                return CallTransitionResult.Conflict(call, $"Cannot end in status {call.Status}.");
        }

        if (force)
        {
            logger.LogInformation(
                "Force end call {CallId} by {Actor} (graceful interrupted)", callId, actor.Id);
            await InterruptActiveDentalClipsAsync(call, "Interrupted by force end", cancellationToken);
            return await CompleteBusinessEndAsync(callId, actor, cancellationToken);
        }

        // Barriers: TrackComposite dental clips still Recording/Finalizing with an egress id
        var barriers = await ListDentalEgressBarriersAsync(call, cancellationToken);
        if (barriers.Count == 0)
        {
            // Fast path — no track-dependent finalize
            return await CompleteBusinessEndAsync(callId, actor, cancellationToken);
        }

        bool startedNow;
        lock (call.SyncRoot)
        {
            if (call.Status == CallStatus.Ended)
                return CallTransitionResult.Ok(call);

            startedNow = !call.GracefulEndPending;
            if (startedNow)
            {
                call.GracefulEndPending = true;
                call.GracefulEndRequestedAt = DateTimeOffset.UtcNow;
                call.GracefulEndRequestedBy = actor.Id;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
        }

        if (startedNow)
        {
            logger.LogInformation(
                "Graceful end start call={CallId} actor={Actor} barriers={Count} grace={Grace}s hard={Hard}s",
                callId, actor.Id, barriers.Count, GraceSeconds, HardTimeoutSeconds);
            // Stop any still-Recording clips once (idempotent StopClipCore)
            await RequestStopDentalBarriersAsync(call, barriers, cancellationToken);
            await dispatcher.NotifyCallAsync(call);
            EnsureGraceLoop(callId, actor);
        }
        else
        {
            logger.LogInformation(
                "Graceful end re-entry call={CallId} actor={Actor} (idempotent)", callId, actor.Id);
            EnsureGraceLoop(callId, actor);
        }

        // Bounded inline wait so short finalizes return Ended in one round-trip
        var inline = TimeSpan.FromSeconds(InlineWaitSeconds);
        if (await WaitBarriersTerminalAsync(call, barriers, inline, cancellationToken))
        {
            logger.LogInformation(
                "Graceful end inline barrier clear call={CallId}", callId);
            return await CompleteBusinessEndAsync(callId, actor, cancellationToken);
        }

        // Still Accepted + GracefulEndPending — FE keeps LiveKit alive
        return CallTransitionResult.Ok(call);
    }

    private void EnsureGraceLoop(Guid callId, TestIdentity actor)
    {
        if (!GraceLoops.TryAdd(callId, 0))
            return;

        _ = Task.Run(async () =>
        {
            try
            {
                await GraceLoopAsync(callId, actor);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Graceful end loop crashed for {CallId}", callId);
            }
            finally
            {
                GraceLoops.TryRemove(callId, out _);
            }
        });
    }

    private async Task GraceLoopAsync(Guid callId, TestIdentity actor)
    {
        if (!calls.TryGetValue(callId, out var call))
            return;

        DateTimeOffset started;
        lock (call.SyncRoot)
            started = call.GracefulEndRequestedAt ?? DateTimeOffset.UtcNow;

        var hardDeadline = started.AddSeconds(HardTimeoutSeconds);
        var poll = TimeSpan.FromMilliseconds(500);

        while (DateTimeOffset.UtcNow < hardDeadline)
        {
            if (!calls.TryGetValue(callId, out call))
                return;

            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Ended)
                    return;
            }

            var barriers = await ListDentalEgressBarriersAsync(call, CancellationToken.None);
            if (barriers.Count == 0
                || await WaitBarriersTerminalAsync(call, barriers, TimeSpan.Zero, CancellationToken.None))
            {
                logger.LogInformation(
                    "Graceful end loop barrier clear call={CallId} → business End", callId);
                await CompleteBusinessEndAsync(callId, actor, CancellationToken.None);
                return;
            }

            await Task.Delay(poll);
        }

        // Hard timeout — complete End so user is never stuck
        logger.LogWarning(
            "Graceful end hard timeout call={CallId} after {Hard}s — completing End",
            callId, HardTimeoutSeconds);
        if (calls.TryGetValue(callId, out call))
            await InterruptActiveDentalClipsAsync(call, "Graceful end hard timeout", CancellationToken.None);
        await CompleteBusinessEndAsync(callId, actor, CancellationToken.None);
    }

    /// <summary>
    /// Dental TrackComposite only — RoomComposite audio does not require patient camera track.
    /// </summary>
    private async Task<IReadOnlyList<MediaAsset>> ListDentalEgressBarriersAsync(
        CallSession call, CancellationToken ct)
    {
        try
        {
            var active = await consultationCatalog.ListActiveAssetsByCallAsync(call.Id, ct);
            return active
                .Where(a =>
                    a.Kind == MediaAssetKinds.DentalVideoClip
                    && !string.IsNullOrWhiteSpace(a.EgressId)
                    && a.Status is MediaAssetStatus.Requested
                        or MediaAssetStatus.Recording
                        or MediaAssetStatus.Finalizing)
                .ToList();
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "List dental barriers failed for {CallId}", call.Id);
            return Array.Empty<MediaAsset>();
        }
    }

    private async Task RequestStopDentalBarriersAsync(
        CallSession call, IReadOnlyList<MediaAsset> barriers, CancellationToken ct)
    {
        foreach (var asset in barriers)
        {
            try
            {
                // StopClipCore is safe when already Finalizing (marks + RequestStop once-ish)
                await clipService.StopClipCoreAsync(asset, call, ct);
                logger.LogInformation(
                    "Graceful end stop clip call={CallId} asset={AssetId} egress={EgressId} status={Status}",
                    call.Id, asset.Id, asset.EgressId, asset.Status);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Graceful end StopClip failed asset={AssetId}", asset.Id);
            }
        }
    }

    /// <summary>
    /// True when every barrier egress is terminal (or asset catalog already terminal).
    /// Does NOT require asset Ready.
    /// </summary>
    private async Task<bool> WaitBarriersTerminalAsync(
        CallSession call,
        IReadOnlyList<MediaAsset> barriers,
        TimeSpan maxWait,
        CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + maxWait;
        IReadOnlyList<MediaAsset> current = barriers;

        do
        {
            if (current.Count == 0)
                return true;

            var allTerminal = true;
            foreach (var asset in current)
            {
                // Fresh catalog row
                MediaAsset? fresh = null;
                try
                {
                    fresh = await consultationCatalog.GetAssetByIdAsync(asset.Id, ct);
                }
                catch { /* ignore */ }

                var row = fresh ?? asset;
                if (MediaAssetStatus.IsTerminal(row.Status))
                    continue; // Ready/Failed — barrier clear for this asset

                if (string.IsNullOrWhiteSpace(row.EgressId))
                {
                    allTerminal = false;
                    continue;
                }

                try
                {
                    var info = await egress.GetEgressStatusAsync(row.EgressId, ct);
                    var st = info?.Status;
                    logger.LogDebug(
                        "Graceful barrier poll call={CallId} asset={AssetId} egress={EgressId} status={Status}",
                        call.Id, row.Id, row.EgressId, st);

                    if (!EgressLifecycle.IsTerminal(st))
                    {
                        allTerminal = false;
                        continue;
                    }

                    // Best-effort: feed finalize service path via Apply if COMPLETE/FAILED
                    // (webhook may race; reconcile also handles). Do not wait for Ready.
                    try
                    {
                        // Trigger catalog update for FAILED early; COMPLETE Ready is async OK
                        if (EgressLifecycle.IsFailedTerminal(st))
                        {
                            await consultationCatalog.TryMarkFailedAsync(
                                row.Id, row.EgressId,
                                info?.Error ?? EgressLifecycle.Normalize(st), ct);
                        }
                    }
                    catch (Exception ex)
                    {
                        logger.LogDebug(ex, "Barrier catalog touch failed for {AssetId}", row.Id);
                    }
                }
                catch (Exception ex)
                {
                    logger.LogDebug(ex, "ListEgress barrier poll failed {EgressId}", row.EgressId);
                    allTerminal = false;
                }
            }

            if (allTerminal)
                return true;

            if (maxWait <= TimeSpan.Zero || DateTimeOffset.UtcNow >= deadline)
                return false;

            await Task.Delay(400, ct);
            current = await ListDentalEgressBarriersAsync(call, ct);
            // If list empty (moved to Ready/Failed), clear
            if (current.Count == 0)
                return true;
        } while (DateTimeOffset.UtcNow < deadline);

        return false;
    }

    private async Task InterruptActiveDentalClipsAsync(
        CallSession call, string reason, CancellationToken ct)
    {
        try
        {
            var active = await consultationCatalog.ListActiveAssetsByCallAsync(call.Id, ct);
            foreach (var asset in active.Where(a => a.Kind == MediaAssetKinds.DentalVideoClip))
            {
                try
                {
                    if (!string.IsNullOrWhiteSpace(asset.EgressId))
                    {
                        try { await egress.RequestStopAsync(asset.EgressId, ct); }
                        catch { /* ignore */ }
                    }
                    await consultationCatalog.TryMarkFailedAsync(
                        asset.Id, asset.EgressId, reason, ct);
                    logger.LogWarning(
                        "Dental clip interrupted call={CallId} asset={AssetId}: {Reason}",
                        call.Id, asset.Id, reason);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Interrupt mark failed for {AssetId}", asset.Id);
                }
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "InterruptActiveDentalClips failed for {CallId}", call.Id);
        }

        lock (call.SyncRoot)
        {
            call.ActiveDentalClipAssetId = null;
            call.ActiveDentalClipStatus = "Idle";
        }
    }

    /// <summary>
    /// Business End + stop remaining media (audio etc.). Call status → Ended.
    /// Frontend may disconnect LiveKit only after this.
    /// </summary>
    private async Task<CallTransitionResult> CompleteBusinessEndAsync(
        Guid callId,
        TestIdentity actor,
        CancellationToken cancellationToken)
    {
        var result = await dispatcher.TryEndAsync(callId, actor);
        if (result.Kind != CallTransitionKind.Ok || result.Call is null)
            return result;

        var call = result.Call;
        lock (call.SyncRoot)
        {
            call.GracefulEndPending = false;
        }

        string? egressId;
        string? recordingId;
        RecordingMode mode;
        lock (call.SyncRoot)
        {
            egressId = call.RecordingStatus is "Stopping" or "Recording"
                ? call.RecordingEgressId
                : null;
            recordingId = call.RecordingId;
            mode = call.RecordingMode;
            if (egressId is not null && call.RecordingStatus == "Recording")
                call.RecordingStatus = "Stopping";
        }

        // Stop remaining consultation media (audio + any residual clips)
        if (mediaLifecycle is not null)
        {
            try
            {
                await mediaLifecycle.StopAllActiveMediaAsync(call, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "StopAllActiveMedia failed on call end {CallId}", call.Id);
            }
        }

        if (!string.IsNullOrWhiteSpace(egressId))
        {
            var recId = recordingId ?? Guid.NewGuid().ToString("N");
            try
            {
                await catalog.TryMarkFinalizingAsync(recId, egressId, cancellationToken);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Catalog Finalizing on call end failed for {RecordingId}", recId);
            }

            try
            {
                await egress.RequestStopAsync(egressId, cancellationToken);
                audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                    "RecordingStopRequested", "Ok", mode.ToString());
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "StopEgress control failed on call end (keeping Finalizing) {EgressId}", egressId);
                audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                    "RecordingStopRequested", "TransportError", ex.Message);
            }
        }

        logger.LogInformation(
            "Business call Ended call={CallId} actor={Actor}", callId, actor.Id);
        await dispatcher.NotifyCallAsync(call);
        return CallTransitionResult.Ok(call);
    }
}
