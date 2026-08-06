namespace LiveKitPoc.Api;

/// <summary>
/// Shared end path for staff + embed visitor: transition → release → stop recording → notify.
/// </summary>
public sealed class CallEndService(
    CallDispatcher dispatcher,
    LiveKitEgressService egress)
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
        lock (call.SyncRoot)
        {
            egressId = call.RecordingStatus is "Stopping" or "Recording"
                ? call.RecordingEgressId
                : null;
            fileName = call.RecordingFileName;
            if (egressId is not null && call.RecordingStatus == "Recording")
                call.RecordingStatus = "Stopping";
        }

        if (string.IsNullOrWhiteSpace(egressId) || string.IsNullOrWhiteSpace(fileName))
            return result;

        try
        {
            await egress.StopRecordingAsync(egressId, fileName, cancellationToken);
            lock (call.SyncRoot)
            {
                call.RecordingStatus = "Complete";
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
        }
        catch
        {
            lock (call.SyncRoot)
            {
                call.RecordingStatus = "Failed";
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
        }

        await dispatcher.NotifyCallAsync(call);
        return CallTransitionResult.Ok(call);
    }
}
