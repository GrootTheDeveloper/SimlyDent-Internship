namespace LiveKitPoc.Api;

public sealed class DentalClipService(
    IConsultationCatalog catalog,
    LiveKitEgressService egress,
    LiveKitRoomService roomService,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    CallMediaGate mediaGate,
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
        // Gate coordinates with graceful End — do not hold call.SyncRoot across awaits.
        using var _gate = await mediaGate.AcquireAsync(call.Id, ct);

        if (call.Status != CallStatus.Accepted)
            throw new InvalidOperationException("Call must be Accepted to record dental clip.");
        if (call.GracefulEndPending)
            throw new InvalidOperationException("Cuộc gọi đang kết thúc — không thể quay clip mới.");

        var policy = policies.Get(call.ClinicId);

        var session = await catalog.GetSessionByCallIdAsync(call.Id, ct)
                      ?? throw new InvalidOperationException("Consultation session not found.");

        // Re-check after catalog await — End may have been claimed
        if (call.GracefulEndPending || call.Status != CallStatus.Accepted)
            throw new InvalidOperationException("Cuộc gọi đang kết thúc — không thể quay clip mới.");

        var existing = await catalog.GetActiveDentalClipAsync(call.Id, ct);
        if (existing is not null)
            throw new MediaAssetConflictException("A dental clip is already active for this call.");

        string? resolvedTrackSid = null;
        try
        {
            var track = await roomService.FindPatientCameraTrackAsync(
                call.RoomName, patientParticipantIdentity, ct);
            if (track is not null)
                resolvedTrackSid = track.Value.trackSid;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "FindPatientCameraTrack failed for {Identity}", patientParticipantIdentity);
        }

        if (string.IsNullOrWhiteSpace(resolvedTrackSid)
            && !string.IsNullOrWhiteSpace(patientVideoTrackSidHint))
        {
            var hint = patientVideoTrackSidHint.Trim();
            if (hint.StartsWith("TR_", StringComparison.Ordinal)
                && !hint.Contains("smoke", StringComparison.OrdinalIgnoreCase)
                && hint.Length >= 8)
            {
                resolvedTrackSid = hint;
                logger.LogInformation(
                    "Using client trackSid hint {Sid} for dental clip (server resolve empty)",
                    resolvedTrackSid);
            }
        }

        if (string.IsNullOrWhiteSpace(resolvedTrackSid))
            throw new InvalidOperationException(
                "Không tìm thấy camera bệnh nhân trong room. Khách phải join LiveKit và bật camera trước khi quay clip.");

        if (call.GracefulEndPending || call.Status != CallStatus.Accepted)
            throw new InvalidOperationException("Cuộc gọi đang kết thúc — không thể quay clip mới.");

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

        // Local hint so End barrier sees activity even if catalog list races
        lock (call.SyncRoot)
        {
            call.ActiveDentalClipAssetId = assetId;
            call.ActiveDentalClipStatus = "Requested";
            call.ConsultationSessionId = session.Id;
        }

        await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, storageKey,
            mimeType: "video/mp4", bytes: null, etag: null,
            width: actualWidth, height: actualHeight, durationMs: null,
            bitrateKbps: null, codec: "H264", ct);

        // Abort cleanly if End claimed after insert but before Egress
        if (call.GracefulEndPending || call.Status != CallStatus.Accepted)
        {
            await catalog.TryMarkFailedAsync(assetId, null, "Aborted: call end requested before egress start", ct);
            lock (call.SyncRoot)
            {
                call.ActiveDentalClipAssetId = null;
                call.ActiveDentalClipStatus = "Idle";
            }
            audit.Append(call.ClinicId, call.Id, assetId.ToString(), staff.Id, staff.Role,
                "DentalClipAbortedOnEnd", "Failed", "end before egress");
            throw new InvalidOperationException("Cuộc gọi đang kết thúc — không thể quay clip mới.");
        }

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
            throw new InvalidOperationException(
                "Không start được clip Egress: " + ex.Message, ex);
        }

        await catalog.TryMarkRecordingAsync(assetId, result.EgressId, ct);
        lock (call.SyncRoot)
        {
            call.ActiveDentalClipAssetId = assetId;
            call.ActiveDentalClipStatus = "Recording";
            call.ConsultationSessionId = session.Id;
        }

        // If End claimed during StartEgress, asset is a known barrier with egressId — End will stop it.
        if (call.GracefulEndPending)
        {
            logger.LogInformation(
                "Dental clip started under End pending call={CallId} asset={AssetId} egress={EgressId} — End will stop",
                call.Id, assetId, result.EgressId);
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
