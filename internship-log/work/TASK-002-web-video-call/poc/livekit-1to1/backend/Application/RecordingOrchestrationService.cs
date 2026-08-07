using System.Collections.Concurrent;
using System.Security.Claims;

namespace LiveKitPoc.Api;

/// <summary>
/// Application service for the <b>legacy</b> single-recording-per-call path
/// (<see cref="IRecordingCatalog"/> + CallSession.Recording* fields).
/// <para>
/// Canonical multi-asset media (CallAudio / DentalVideoClip / Snapshot) is owned by
/// ConsultationAudioService, DentalClipService, SnapshotService + IConsultationCatalog.
/// Do not route new product features through this service.
/// </para>
/// </summary>
[Obsolete("Legacy composite recording path. Prefer consultation media_assets (CallAudio / DentalVideoClip).")]
public sealed class RecordingOrchestrationService(
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    LiveKitEgressService egress,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    CallDispatcher dispatcher,
    RecordingAuditService audit,
    ILogger<RecordingOrchestrationService> logger)
{
    public sealed record Outcome(IResult Result);

    /// <summary>Start legacy room-composite recording for a call. Recording failure never ends the call.</summary>
    public async Task<IResult> StartLegacyRecordingAsync(
        Guid callId,
        TestIdentity actor,
        CancellationToken cancellationToken = default)
    {
        var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, actor);
        if (call is null) return Results.NotFound();
        if (!RecordingAuthorization.CanStartStop(actor, call))
            return Results.Json(new { error = "Only call staff may start recording." }, statusCode: 403);

        var policy = policies.Get(call.ClinicId);
        RecordingMode mode;
        string fileName;
        string recId;
        string storageKey;
        lock (call.SyncRoot)
        {
            var gate = RecordingAuthorization.ValidateStart(call, policy);
            if (gate is not null)
                return Results.Conflict(new { error = gate });
            mode = call.RecordingMode;
            recId = Guid.NewGuid().ToString("N");
            fileName = $"clinic-{call.ClinicId}-call-{call.Id:N}-{recId}.mp4";
            storageKey = storage.BuildKey(call.ClinicId, call.Id, recId, "mp4");
            call.RecordingStatus = "Starting";
            call.RecordingFileName = fileName;
            call.RecordingId = recId;
            call.RecordingEgressId = null;
            call.RecordingStorageKey = storageKey;
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }

        var retentionUntil = DateTimeOffset.UtcNow.AddDays(policy.RetentionDays);
        try
        {
            await catalog.InsertRequestedAsync(
                recId,
                call.ClinicId,
                call.Id,
                mode.ToString(),
                storageKey,
                "Composite",
                retentionUntil,
                call.CallerId,
                call.AssignedStaffId ?? call.CalleeId,
                call.Status.ToString(),
                call.ConsentStatus.ToString(),
                fileName,
                cancellationToken);
        }
        catch (Exception ex)
        {
            lock (call.SyncRoot)
            {
                call.RecordingStatus = "Failed";
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStartFailed", "Failed", $"catalog: {ex.Message}");
            await dispatcher.NotifyCallAsync(call);
            return Results.Json(new { error = $"Không thể tạo ledger ghi hình: {ex.Message}", call = call.ToView() },
                statusCode: 503);
        }

        await dispatcher.NotifyCallAsync(call);

        try
        {
            var result = await egress.StartRoomRecordingAsync(
                call.RoomName, fileName, mode, storageKey, cancellationToken);
            lock (call.SyncRoot)
            {
                call.RecordingEgressId = result.EgressId;
                call.RecordingStatus = "Recording";
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
            await catalog.TryMarkRecordingAsync(recId, result.EgressId, cancellationToken);
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStarted", "Ok", mode.ToString());
            await dispatcher.NotifyCallAsync(call);
            return Results.Ok(RecordingAuthorization.BuildView(call, actor, policy));
        }
        catch (Exception ex)
        {
            lock (call.SyncRoot)
            {
                call.RecordingStatus = "Failed";
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
            try { await catalog.TryMarkFailedAsync(recId, "", ex.Message, cancellationToken); }
            catch { /* best-effort */ }
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStartFailed", "Failed", ex.Message);
            await dispatcher.NotifyCallAsync(call);
            // Call remains Accepted — recording failure ≠ call failure.
            logger.LogWarning(ex, "Legacy recording start failed for {CallId}", call.Id);
            return Results.Json(new { error = $"Không thể bắt đầu ghi: {ex.Message}", call = call.ToView() }, statusCode: 503);
        }
    }

    /// <summary>Async stop: Finalizing + StopEgress; Ready via webhook/reconcile.</summary>
    public async Task<IResult> StopLegacyRecordingAsync(
        Guid callId,
        TestIdentity actor,
        CancellationToken cancellationToken = default)
    {
        var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, actor);
        if (call is null) return Results.NotFound();
        if (!RecordingAuthorization.CanStartStop(actor, call))
            return Results.Json(new { error = "Only call staff may stop recording." }, statusCode: 403);

        var policy = policies.Get(call.ClinicId);
        string egressId;
        string recId;
        lock (call.SyncRoot)
        {
            if (call.RecordingStatus != "Recording" || string.IsNullOrWhiteSpace(call.RecordingEgressId))
                return Results.Conflict(new { error = "This call is not being recorded." });
            egressId = call.RecordingEgressId;
            recId = call.RecordingId ?? Guid.NewGuid().ToString("N");
            call.RecordingStatus = "Stopping";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }

        try { await catalog.TryMarkFinalizingAsync(recId, egressId, cancellationToken); }
        catch { /* dual-write best-effort */ }
        await dispatcher.NotifyCallAsync(call);

        try
        {
            await egress.RequestStopAsync(egressId, cancellationToken);
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStopRequested", "Ok");
        }
        catch (Exception ex)
        {
            audit.Append(call.ClinicId, call.Id, recId, actor.Id, actor.Role,
                "RecordingStopRequested", "TransportError", ex.Message);
        }

        return Results.Ok(RecordingAuthorization.BuildView(call, actor, policy));
    }
}