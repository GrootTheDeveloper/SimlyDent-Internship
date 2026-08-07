namespace LiveKitPoc.Api;

/// <summary>
/// Shared end path for staff + embed visitor: transition → release → stop recording → archive → notify.
/// Recording finalize failure never reverts call End.
/// </summary>
public sealed class CallEndService(
    CallDispatcher dispatcher,
    LiveKitEgressService egress,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    RecordingAuditService audit)
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
        string? fileName;
        string? recordingId;
        RecordingMode mode;
        lock (call.SyncRoot)
        {
            egressId = call.RecordingStatus is "Stopping" or "Recording"
                ? call.RecordingEgressId
                : null;
            fileName = call.RecordingFileName;
            recordingId = call.RecordingId;
            mode = call.RecordingMode;
            if (egressId is not null && call.RecordingStatus == "Recording")
                call.RecordingStatus = "Stopping";
        }

        if (string.IsNullOrWhiteSpace(egressId) || string.IsNullOrWhiteSpace(fileName))
            return result;

        var recId = recordingId ?? Guid.NewGuid().ToString("N");
        try { await catalog.MarkFinalizingAsync(recId, cancellationToken); }
        catch { /* dual-write best-effort */ }

        try
        {
            await egress.StopRecordingAsync(egressId, fileName, cancellationToken);
            var key = await RecordingFinalize.MaterializeObjectAsync(
                egress, storage, call.ClinicId, call.Id, recId, fileName, cancellationToken);

            lock (call.SyncRoot)
            {
                call.RecordingId = recId;
                call.RecordingStorageKey = key;
                call.RecordingStatus = "Complete";
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }

            try { await catalog.MarkReadyAsync(recId, key, cancellationToken: cancellationToken); }
            catch { /* dual-write best-effort */ }

            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStopped", "Ok", mode.ToString());
        }
        catch (Exception ex)
        {
            // Call remains Ended (dispatcher already transitioned). Recording fails separately.
            lock (call.SyncRoot)
            {
                call.RecordingStatus = "Failed";
                call.RecordingStorageKey = null;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }

            try { await catalog.MarkFailedAsync(recId, ex.Message, cancellationToken); }
            catch { /* dual-write best-effort */ }

            audit.Append(call.ClinicId, call.Id, recordingId, actor.Id, actor.Role,
                "RecordingFinalizeFailed", "Failed", ex.Message);
        }

        await dispatcher.NotifyCallAsync(call);
        return CallTransitionResult.Ok(call);
    }
}
