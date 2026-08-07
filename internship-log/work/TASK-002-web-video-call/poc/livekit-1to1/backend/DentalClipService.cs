namespace LiveKitPoc.Api;

public sealed class DentalClipService(
    IConsultationCatalog catalog,
    LiveKitEgressService egress,
    LiveKitRoomService roomService,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    ILogger<DentalClipService> logger)
{
    public async Task<(Guid AssetId, string Status)> StartClipAsync(
        CallSession call,
        TestIdentity staff,
        string patientParticipantIdentity,
        string? patientVideoTrackSidHint,
        int? actualWidth,
        int? actualHeight,
        CancellationToken ct = default)
    {
        if (call.Status != CallStatus.Accepted)
            throw new InvalidOperationException("Call must be Accepted to record dental clip.");

        var policy = policies.Get(call.ClinicId);
        if (policy.RequireConsent && call.ConsentStatus != ConsentStatus.Granted)
            throw new InvalidOperationException("Consent required before dental clip recording.");

        var session = await catalog.GetSessionByCallIdAsync(call.Id, ct)
                      ?? throw new InvalidOperationException("Consultation session not found.");

        var existing = await catalog.GetActiveDentalClipAsync(call.Id, ct);
        if (existing is not null)
            throw new MediaAssetConflictException("A dental clip is already active for this call.");

        var track = await roomService.FindPatientCameraTrackAsync(
            call.RoomName, patientParticipantIdentity, ct);
        if (track is null)
            throw new InvalidOperationException("Patient camera must be enabled before recording.");

        var resolvedTrackSid = track.Value.trackSid;
        if (!string.IsNullOrWhiteSpace(patientVideoTrackSidHint)
            && !string.Equals(patientVideoTrackSidHint, resolvedTrackSid, StringComparison.Ordinal))
        {
            logger.LogInformation(
                "Client trackSid hint {Hint} ignored; using server-resolved {Sid}",
                patientVideoTrackSidHint, resolvedTrackSid);
        }

        var assetId = Guid.NewGuid();
        var storageKey = MediaStorageKeys.VideoClipKey(call.ClinicId, call.Id, assetId);
        var fileName = $"clip-{call.Id:N}-{assetId:N}.mp4";
        var retentionUntil = DateTimeOffset.UtcNow.AddDays(policy.RetentionDays);

        try
        {
            assetId = await catalog.InsertMediaAssetAsync(new MediaAssetInsert(
                assetId, session.Id, call.Id, call.ClinicId,
                MediaAssetKinds.DentalVideoClip, staff.Id,
                patientParticipantIdentity, resolvedTrackSid,
                retentionUntil), ct);
        }
        catch (MediaAssetConflictException)
        {
            throw;
        }

        await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, storageKey,
            mimeType: "video/mp4", bytes: null, etag: null,
            width: actualWidth, height: actualHeight, durationMs: null,
            bitrateKbps: null, codec: "H264", ct);

        EgressResult result;
        try
        {
            result = await egress.StartTrackCompositeRecordingAsync(
                call.RoomName, resolvedTrackSid, fileName, storageKey,
                DentalQualityProfile.HD_720p_30, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Dental clip Egress start failed for call {CallId}", call.Id);
            await catalog.TryMarkFailedAsync(assetId, null, ex.Message, ct);
            lock (call.SyncRoot)
            {
                call.ActiveDentalClipAssetId = null;
                call.ActiveDentalClipStatus = "Idle";
            }
            audit.Append(call.ClinicId, call.Id, assetId.ToString(), staff.Id, staff.Role,
                "DentalClipStartFailed", "Failed", ex.Message);
            throw;
        }

        await catalog.TryMarkRecordingAsync(assetId, result.EgressId, ct);
        lock (call.SyncRoot)
        {
            call.ActiveDentalClipAssetId = assetId;
            call.ActiveDentalClipStatus = "Recording";
            call.ConsultationSessionId = session.Id;
        }
        audit.Append(call.ClinicId, call.Id, assetId.ToString(), staff.Id, staff.Role,
            "DentalClipStarted", "Ok",
            $"track={resolvedTrackSid};egress={result.EgressId};{actualWidth}x{actualHeight}");
        return (assetId, MediaAssetStatus.Recording);
    }

    public async Task StopClipCoreAsync(
        MediaAsset asset, CallSession call, CancellationToken ct = default)
    {
        if (!MediaAssetStatus.IsActive(asset.Status)) return;
        if (string.IsNullOrWhiteSpace(asset.EgressId)) return;

        try { await catalog.TryMarkFinalizingAsync(asset.Id, asset.EgressId, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Clip Finalizing mark failed"); }

        lock (call.SyncRoot)
        {
            if (call.ActiveDentalClipAssetId == asset.Id)
                call.ActiveDentalClipStatus = "Finalizing";
        }

        try { await egress.RequestStopAsync(asset.EgressId, ct); }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "StopEgress control failed for clip {EgressId} (staying Finalizing)", asset.EgressId);
        }

        audit.Append(call.ClinicId, call.Id, asset.Id.ToString(), "system", "System",
            "DentalClipStopRequested", "Ok");
    }

    public async Task<bool> StopClipAsync(
        CallSession call, Guid assetId, TestIdentity staff, CancellationToken ct = default)
    {
        var asset = await catalog.GetAssetByIdAsync(assetId, ct);
        if (asset is null) return false;
        if (!string.Equals(asset.ClinicId, call.ClinicId, StringComparison.OrdinalIgnoreCase))
            return false;
        if (asset.CallId != call.Id) return false;
        if (asset.Kind != MediaAssetKinds.DentalVideoClip) return false;
        if (!MediaAssetStatus.IsActive(asset.Status)) return false;

        await StopClipCoreAsync(asset, call, ct);
        audit.Append(call.ClinicId, call.Id, asset.Id.ToString(), staff.Id, staff.Role,
            "DentalClipStopRequested", "Ok");
        return true;
    }
}
