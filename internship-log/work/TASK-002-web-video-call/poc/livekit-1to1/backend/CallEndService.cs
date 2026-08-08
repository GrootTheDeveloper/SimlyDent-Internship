using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Shared end path for staff + embed visitor.
/// Dental TrackComposite: claim End intent early, fail-closed barrier lookup,
/// wait Egress terminal (not asset Ready) before business Ended.
/// </summary>
public sealed class CallEndService(
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher,
    LiveKitEgressService egress,
    IRecordingCatalog catalog,
    RecordingAuditService audit,
    IConsultationCatalog consultationCatalog,
    DentalClipService clipService,
    CallMediaGate mediaGate,
    ILogger<CallEndService> logger,
    ConsultationMediaLifecycleService? mediaLifecycle = null,
    IConfiguration? configuration = null)
{
    private static readonly ConcurrentDictionary<Guid, byte> GraceLoops = new();

    public static int GraceSeconds { get; private set; } = 12;
    public static int HardTimeoutSeconds { get; private set; } = 45;
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
        Guid callId, TestIdentity actor, CancellationToken cancellationToken = default) =>
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
            // Claim end intent so StartClip aborts
            ClaimGracefulEndIntent(call, actor);
            using (await mediaGate.AcquireAsync(callId, cancellationToken))
            {
                await InterruptActiveDentalClipsAsync(call, "Interrupted by force end", cancellationToken);
            }
            return await CompleteBusinessEndAsync(callId, actor, cancellationToken);
        }

        // 1) Atomically claim End intent BEFORE barrier discovery / network work
        //    so StartClip cannot win a race and StartEgress after "empty" scan.
        var startedNow = ClaimGracefulEndIntent(call, actor);
        if (startedNow)
            await dispatcher.NotifyCallAsync(call);

        // 2) Acquire media gate so in-flight StartClip finishes or aborts
        BarrierLookupResult lookup;
        IReadOnlyList<MediaAsset> barriers;
        using (await mediaGate.AcquireAsync(callId, cancellationToken))
        {
            lookup = await ListDentalEgressBarriersAsync(call, cancellationToken);
            barriers = lookup.Barriers;

            if (lookup.MayFastPathEnd && !LocalClipHintNeedsProtection(call))
            {
                logger.LogInformation(
                    "Graceful end fast-path call={CallId} (known empty barriers)", callId);
                return await CompleteBusinessEndAsync(callId, actor, cancellationToken);
            }

            if (lookup.Kind == BarrierLookupKind.KnownBarriers)
            {
                logger.LogInformation(
                    "Graceful end barriers call={CallId} count={Count} startedNow={Started}",
                    callId, barriers.Count, startedNow);
                await RequestStopDentalBarriersAsync(call, barriers, cancellationToken);
            }
            else if (lookup.Kind == BarrierLookupKind.Unknown)
            {
                logger.LogWarning(
                    "Graceful end barrier Unknown call={CallId} error={Error} — fail-closed, keep media",
                    callId, lookup.Error);
            }
        }

        EnsureGraceLoop(callId, actor);

        // 3) Bounded inline wait (only when we have known barriers or recover from unknown)
        var inline = TimeSpan.FromSeconds(InlineWaitSeconds);
        if (await WaitUntilSafeToEndAsync(call, inline, cancellationToken))
        {
            logger.LogInformation("Graceful end inline clear call={CallId}", callId);
            return await CompleteBusinessEndAsync(callId, actor, cancellationToken);
        }

        return CallTransitionResult.Ok(call);
    }

    /// <summary>Set GracefulEndPending under SyncRoot. Returns true if newly claimed.</summary>
    private static bool ClaimGracefulEndIntent(CallSession call, TestIdentity actor)
    {
        lock (call.SyncRoot)
        {
            if (call.Status == CallStatus.Ended)
                return false;
            if (call.GracefulEndPending)
                return false;
            call.GracefulEndPending = true;
            call.GracefulEndRequestedAt = DateTimeOffset.UtcNow;
            call.GracefulEndRequestedBy = actor.Id;
            call.UpdatedAt = DateTimeOffset.UtcNow;
            return true;
        }
    }

    private static bool LocalClipHintNeedsProtection(CallSession call)
    {
        lock (call.SyncRoot)
        {
            var st = call.ActiveDentalClipStatus ?? "Idle";
            return st is "Recording" or "Finalizing" or "Requested"
                   || call.ActiveDentalClipAssetId is not null;
        }
    }

    private void EnsureGraceLoop(Guid callId, TestIdentity actor)
    {
        if (!GraceLoops.TryAdd(callId, 0))
            return;

        _ = Task.Run(async () =>
        {
            try { await GraceLoopAsync(callId, actor); }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Graceful end loop crashed for {CallId}", callId);
            }
            finally { GraceLoops.TryRemove(callId, out _); }
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
        var attempt = 0;

        while (DateTimeOffset.UtcNow < hardDeadline)
        {
            attempt++;
            if (!calls.TryGetValue(callId, out call))
                return;
            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Ended)
                    return;
            }

            if (await WaitUntilSafeToEndAsync(call, TimeSpan.Zero, CancellationToken.None))
            {
                logger.LogInformation(
                    "Graceful end loop safe call={CallId} attempt={Attempt} → business End",
                    callId, attempt);
                await CompleteBusinessEndAsync(callId, actor, CancellationToken.None);
                return;
            }

            var elapsed = (DateTimeOffset.UtcNow - started).TotalSeconds;
            logger.LogDebug(
                "Graceful end loop wait call={CallId} attempt={Attempt} elapsed={Elapsed:F1}s",
                callId, attempt, elapsed);
            await Task.Delay(500);
        }

        logger.LogWarning(
            "Graceful end hard timeout call={CallId} after {Hard}s — force cleanup",
            callId, HardTimeoutSeconds);
        if (calls.TryGetValue(callId, out call))
        {
            using (await mediaGate.AcquireAsync(callId, CancellationToken.None))
            {
                await InterruptActiveDentalClipsAsync(call, "Graceful end hard timeout", CancellationToken.None);
            }
        }
        await CompleteBusinessEndAsync(callId, actor, CancellationToken.None);
    }

    /// <summary>
    /// True only when barrier lookup is KnownEmpty (or all barriers egress-terminal).
    /// Unknown / Requested-without-egress → false.
    /// </summary>
    private async Task<bool> WaitUntilSafeToEndAsync(
        CallSession call, TimeSpan maxWait, CancellationToken ct)
    {
        var deadline = DateTimeOffset.UtcNow + maxWait;
        do
        {
            BarrierLookupResult lookup;
            using (await mediaGate.AcquireAsync(call.Id, ct))
            {
                lookup = await ListDentalEgressBarriersAsync(call, ct);
            }

            if (lookup.MayFastPathEnd && !LocalClipHintNeedsProtection(call))
                return true;

            if (lookup.Kind == BarrierLookupKind.Unknown)
            {
                if (maxWait <= TimeSpan.Zero || DateTimeOffset.UtcNow >= deadline)
                    return false;
                await Task.Delay(400, ct);
                continue;
            }

            if (lookup.Kind == BarrierLookupKind.KnownBarriers)
            {
                // Stop any still-recording (idempotent)
                using (await mediaGate.AcquireAsync(call.Id, ct))
                {
                    await RequestStopDentalBarriersAsync(call, lookup.Barriers, ct);
                }

                if (await AllBarriersEgressTerminalAsync(call, lookup.Barriers, ct))
                    return true;
            }

            if (maxWait <= TimeSpan.Zero || DateTimeOffset.UtcNow >= deadline)
                return false;

            await Task.Delay(400, ct);
        } while (DateTimeOffset.UtcNow < deadline);

        return false;
    }

    /// <summary>
    /// Fail-closed barrier list. Includes Requested without egressId (StartClip in-flight).
    /// </summary>
    internal async Task<BarrierLookupResult> ListDentalEgressBarriersAsync(
        CallSession call, CancellationToken ct)
    {
        try
        {
            var active = await consultationCatalog.ListActiveAssetsByCallAsync(call.Id, ct);
            var barriers = active
                .Where(a =>
                    a.Kind == MediaAssetKinds.DentalVideoClip
                    && a.Status is MediaAssetStatus.Requested
                        or MediaAssetStatus.Recording
                        or MediaAssetStatus.Finalizing)
                .ToList();

            if (barriers.Count == 0)
            {
                // Local hint: call thinks clip is active but catalog empty → Unknown (race)
                if (LocalClipHintNeedsProtection(call))
                {
                    return BarrierLookupResult.Unknown(
                        "Catalog empty but CallSession ActiveDentalClip hints protection needed");
                }
                return BarrierLookupResult.Empty();
            }

            return BarrierLookupResult.WithBarriers(barriers);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "List dental barriers failed call={CallId} — fail-closed Unknown", call.Id);
            return BarrierLookupResult.Unknown(ex.Message);
        }
    }

    private async Task<bool> AllBarriersEgressTerminalAsync(
        CallSession call, IReadOnlyList<MediaAsset> barriers, CancellationToken ct)
    {
        if (barriers.Count == 0)
            return true;

        foreach (var asset in barriers)
        {
            MediaAsset? fresh = null;
            try { fresh = await consultationCatalog.GetAssetByIdAsync(asset.Id, ct); }
            catch
            {
                return false; // fail-closed
            }

            var row = fresh ?? asset;
            if (MediaAssetStatus.IsTerminal(row.Status))
                continue;

            // Requested / Recording without egress — StartClip still in flight or failed mid-way
            if (string.IsNullOrWhiteSpace(row.EgressId))
                return false;

            try
            {
                var info = await egress.GetEgressStatusAsync(row.EgressId, ct);
                var st = info?.Status;
                logger.LogDebug(
                    "Barrier poll call={CallId} asset={AssetId} egress={EgressId} status={Status}",
                    call.Id, row.Id, row.EgressId, st);

                if (!EgressLifecycle.IsTerminal(st))
                    return false;

                if (EgressLifecycle.IsFailedTerminal(st))
                {
                    try
                    {
                        await consultationCatalog.TryMarkFailedAsync(
                            row.Id, row.EgressId,
                            info?.Error ?? EgressLifecycle.Normalize(st), ct);
                    }
                    catch { /* ignore */ }
                }
            }
            catch (Exception ex)
            {
                logger.LogDebug(ex, "ListEgress failed {EgressId}", row.EgressId);
                return false;
            }
        }

        return true;
    }

    private async Task RequestStopDentalBarriersAsync(
        CallSession call, IReadOnlyList<MediaAsset> barriers, CancellationToken ct)
    {
        foreach (var asset in barriers)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(asset.EgressId)
                    && asset.Status == MediaAssetStatus.Requested)
                {
                    // No egress yet — mark failed so it does not block forever if Start aborted
                    // (StartClip under gate should re-check End intent; this is safety net)
                    await consultationCatalog.TryMarkFailedAsync(
                        asset.Id, null, "Aborted: call end requested before egress start", ct);
                    logger.LogInformation(
                        "Graceful end abort Requested asset={AssetId} call={CallId}",
                        asset.Id, call.Id);
                    continue;
                }

                await clipService.StopClipCoreAsync(asset, call, ct);
                logger.LogInformation(
                    "Graceful end stop clip call={CallId} asset={AssetId} egress={EgressId} status={Status}",
                    call.Id, asset.Id, asset.EgressId, asset.Status);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Graceful end StopClip failed asset={AssetId}", asset.Id);
            }
        }
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
                logger.LogWarning(ex, "StopEgress control failed on call end {EgressId}", egressId);
                audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                    "RecordingStopRequested", "TransportError", ex.Message);
            }
        }

        logger.LogInformation("Business call Ended call={CallId} actor={Actor}", callId, actor.Id);
        await dispatcher.NotifyCallAsync(call);
        return CallTransitionResult.Ok(call);
    }
}
