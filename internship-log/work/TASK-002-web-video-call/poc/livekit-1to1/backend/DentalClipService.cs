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

        // Product: clips are staff-initiated (start/stop). Multiple clips per call are allowed
        // sequentially — only one active clip at a time (unique partial index).
        // Consent is not required; staff action is the intentional gate.
        var policy = policies.Get(call.ClinicId);

        var session = await catalog.GetSessionByCallIdAsync(call.Id, ct)
                      ?? throw new InvalidOperationException("Consultation session not found.");

        var existing = await catalog.GetActiveDentalClipAsync(call.Id, ct);
        if (existing is not null)
            throw new MediaAssetConflictException("A dental clip is already active for this call.");

        // Prefer client track SID (staff already sees remote video). Server RoomService is best-effort.
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
            // Reject obvious smoke/fake SIDs — LiveKit Egress would return "track not found" later.
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
