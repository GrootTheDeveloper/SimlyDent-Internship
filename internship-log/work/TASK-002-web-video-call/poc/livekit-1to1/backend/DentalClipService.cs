namespace LiveKitPoc.Api;

public sealed class DentalClipService(
    IConsultationCatalog catalog,
    LiveKitEgressService egress,
    LiveKitRoomService roomService,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    CallMediaGate mediaGate,
    DentalEncodingProfileSelector profileSelector,
    Microsoft.Extensions.Options.IOptions<Options.DentalVideoOptions> dentalOptions,
    ILogger<DentalClipService> logger)
{
    public async Task<(Guid AssetId, string Status)> StartClipAsync(
        CallSession call,
        TestIdentity staff,
        string patientParticipantIdentity,
        string? patientVideoTrackSidHint,
        int? actualWidth,
        int? actualHeight,
        double? actualFrameRate = null,
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

        // Source-aware profile (no upscale / no fake FPS). Client dims are hints only.
        var opt = dentalOptions.Value;
        var encode = opt.IsLegacyPreset
            ? profileSelector.SelectLegacy720p30()
            : profileSelector.Select(actualWidth, actualHeight, actualFrameRate);

        // Persist *output* encode dims as provisional object metadata (probe overwrites later).
        await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, storageKey,
            mimeType: "video/mp4", bytes: null, etag: null,
            width: encode.Width, height: encode.Height, durationMs: null,
            bitrateKbps: encode.VideoBitrateKbps, codec: "H264", ct);

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

        logger.LogInformation(
            "DentalClip encode call={CallId} asset={AssetId} source={SrcW}x{SrcH}@{SrcFps} output={OutW}x{OutH}@{OutFps} bitrate={Bitrate} mode={Mode} profile={Profile}",
            call.Id, assetId,
            actualWidth, actualHeight, actualFrameRate,
            encode.Width, encode.Height, encode.FrameRate, encode.VideoBitrateKbps,
            opt.EncodingMode, encode.ProfileName);

        EgressResult result;
        try
        {
            result = await egress.StartTrackCompositeRecordingAsync(
                call.RoomName, resolvedTrackSid, fileName, storageKey, encode, ct);
        }
        catch (LiveKitEgressException ex) when (
            encode.UsedAdvanced && ex.IsSafeToRetryStartWithDifferentPayload)
        {
            // ONLY deterministic RequestRejected (e.g. advanced options invalid/unsupported).
            // Never retry StartEgress on timeout / 5xx / transport — may already have created Egress.
            logger.LogWarning(ex,
                "DentalClip advanced Egress rejected (safe fallback) call={CallId} asset={AssetId} track={Track} class={Class} http={Http} twirp={Twirp}",
                call.Id, assetId, resolvedTrackSid, ex.Classification, ex.HttpStatus, ex.TwirpCode);
            try
            {
                var legacy = profileSelector.SelectLegacy720p30();
                result = await egress.StartTrackCompositeRecordingAsync(
                    call.RoomName, resolvedTrackSid, fileName, storageKey, legacy, ct);
                encode = legacy;
                await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, storageKey,
                    mimeType: "video/mp4", bytes: null, etag: null,
                    width: legacy.Width, height: legacy.Height, durationMs: null,
                    bitrateKbps: legacy.VideoBitrateKbps, codec: "H264", ct);
                audit.Append(call.ClinicId, call.Id, assetId.ToString(), staff.Id, staff.Role,
                    "DentalClipLegacyFallback", "Ok",
                    $"class={ex.Classification};http={ex.HttpStatus};twirp={ex.TwirpCode}");
            }
            catch (Exception ex2)
            {
                await FailStartAsync(call, assetId, staff, ex2, ct);
                throw new InvalidOperationException(
                    "Không start được clip Egress: " + ex2.Message, ex2);
            }
        }
        catch (LiveKitEgressException ex)
        {
            // Ambiguous or non-retryable: do NOT StartEgress a second time (avoids duplicate recording).
            logger.LogError(ex,
                "DentalClip Egress start failed (no fallback) call={CallId} asset={AssetId} track={Track} class={Class} http={Http} twirp={Twirp} safeRetry={Safe}",
                call.Id, assetId, resolvedTrackSid, ex.Classification, ex.HttpStatus, ex.TwirpCode,
                ex.IsSafeToRetryStartWithDifferentPayload);
            var detail =
                $"class={ex.Classification};http={ex.HttpStatus};twirp={ex.TwirpCode};{ex.Message}";
            await FailStartAsync(call, assetId, staff, ex, ct, detail);
            throw new InvalidOperationException(
                "Không start được clip Egress (không retry để tránh duplicate): " + ex.Message, ex);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "Dental clip Egress start failed (unexpected) call={CallId} asset={AssetId} track={Track}",
                call.Id, assetId, resolvedTrackSid);
            await FailStartAsync(call, assetId, staff, ex, ct);
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
            $"track={resolvedTrackSid};egress={result.EgressId};{encode.AuditDetail}");
        return (assetId, MediaAssetStatus.Recording);
    }

    private async Task FailStartAsync(
        CallSession call,
        Guid assetId,
        TestIdentity staff,
        Exception ex,
        CancellationToken ct,
        string? errorDetail = null)
    {
        var msg = errorDetail ?? ex.Message;
        try { await catalog.TryMarkFailedAsync(assetId, null, msg, ct); }
        catch (Exception markEx)
        {
            logger.LogWarning(markEx, "TryMarkFailed after Egress start failure asset={AssetId}", assetId);
        }
        lock (call.SyncRoot)
        {
            if (call.ActiveDentalClipAssetId == assetId)
            {
                call.ActiveDentalClipAssetId = null;
                call.ActiveDentalClipStatus = "Idle";
            }
        }
        audit.Append(call.ClinicId, call.Id, assetId.ToString(), staff.Id, staff.Role,
            "DentalClipStartFailed", "Failed", msg);
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
