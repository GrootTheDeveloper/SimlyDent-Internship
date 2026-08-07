namespace LiveKitPoc.Api;

/// <summary>
/// Shared end path for staff + embed visitor: transition call End, request StopEgress (short), leave finalize async.
/// Recording finalize failure never reverts call End.
/// </summary>
public sealed class CallEndService(
    CallDispatcher dispatcher,
    LiveKitEgressService egress,
    IRecordingCatalog catalog,
    RecordingAuditService audit,
    ILogger<CallEndService> logger,
    ConsultationMediaLifecycleService? mediaLifecycle = null)
{
    public async Task<CallTransitionResult> EndWithRecordingAsync(
        Guid callId,
        TestIdentity actor,
        CancellationToken cancellationToken = default)
    {
        var result = await dispatcher.TryEndAsync(callId, actor);
        if (result.Kind != CallTransitionKind.Ok || result.Call is null)
            return result;

        var call = result.Call;
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

        // NEW: stop all consultation media assets (audio + dental clips)
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

        if (string.IsNullOrWhiteSpace(egressId))
        {
            await dispatcher.NotifyCallAsync(call);
            return CallTransitionResult.Ok(call);
        }

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
            // Await SHORT control request only — never Materialize / COMPLETE poll.
            await egress.RequestStopAsync(egressId, cancellationToken);
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStopRequested", "Ok", mode.ToString());
        }
        catch (Exception ex)
        {
            // Transport uncertainty: stay Finalizing; reconcile is authority. Call remains Ended.
            logger.LogWarning(ex, "StopEgress control failed on call end (keeping Finalizing) {EgressId}", egressId);
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStopRequested", "TransportError", ex.Message);
        }

        await dispatcher.NotifyCallAsync(call);
        return CallTransitionResult.Ok(call);
    }
}
