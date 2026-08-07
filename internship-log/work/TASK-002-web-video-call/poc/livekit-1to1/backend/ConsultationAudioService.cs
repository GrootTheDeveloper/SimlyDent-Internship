using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;
namespace LiveKitPoc.Api;

/// <summary>
/// Product: full-session CallAudio is always auto-started for Accepted calls
/// (FEATURE_AUTO_CALL_AUDIO kill-switch only). Consent is NOT required for audio.
/// Dental clips remain staff-initiated. Never fails the call.
/// </summary>
public sealed class ConsultationAudioService(
    IConsultationCatalog catalog,
    LiveKitEgressService egress,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    IOptions<FeatureOptions> featureOptions,
    ILogger<ConsultationAudioService> logger)
{
    /// <summary>
    /// Idempotent auto-audio start (Accept + join/token retries).
    /// DB unique index prevents duplicate active audio.
    /// </summary>
    public async Task EnsureAutoAudioStartedAsync(CallSession call, CancellationToken ct = default)
    {
        // Lab 2 vCPU: FEATURE_AUTO_CALL_AUDIO=0 skips room-composite (typed FeatureOptions).
        if (!featureOptions.Value.AutoCallAudio)
        {
            logger.LogInformation("Auto CallAudio skipped (FeatureOptions.AutoCallAudio=false)");
            return;
        }

        if (call.Status != CallStatus.Accepted)
            return;

        // Product rule: CallAudio always auto — do not gate on ConsentStatus.
        // (RequireConsent still applies to legacy composite + optional staff workflows.)

        var session = await catalog.GetSessionByCallIdAsync(call.Id, ct);
        if (session is null) return;

        var policy = policies.Get(call.ClinicId);

        var existing = await catalog.GetActiveAudioAssetAsync(call.Id, ct);
        if (existing is not null)
        {
            lock (call.SyncRoot)
            {
                call.ConsultationSessionId = session.Id;
                if (call.AutoAudioStatus is "Idle" or "")
                    call.AutoAudioStatus = existing.Status == MediaAssetStatus.Recording
                        ? "Recording"
                        : existing.Status == MediaAssetStatus.Finalizing ? "Finalizing" : "Recording";
            }
            return;
        }

        // One successful full-session audio per call (product).
        var sessionAssets = await catalog.ListAssetsBySessionAsync(session.Id, ct);
        var readyAudio = sessionAssets.FirstOrDefault(a =>
            a.Kind == MediaAssetKinds.CallAudio && a.Status == MediaAssetStatus.Ready);
        if (readyAudio is not null)
        {
            lock (call.SyncRoot)
            {
                call.ConsultationSessionId = session.Id;
                call.AutoAudioStatus = "Ready";
            }
            return;
        }

        var assetId = Guid.NewGuid();
        var storageKey = MediaStorageKeys.AudioKey(call.ClinicId, call.Id, assetId);
        var fileName = $"audio-{Sanitize(call.ClinicId)}-{call.Id:N}-{assetId:N}.mp3";

        try
        {
            var retentionUntil = DateTimeOffset.UtcNow.AddDays(policy.RetentionDays);
            assetId = await catalog.InsertMediaAssetAsync(new MediaAssetInsert(
                assetId, session.Id, call.Id, call.ClinicId,
                MediaAssetKinds.CallAudio, CreatedBy: null,
                SourceParticipantId: null, SourceTrackId: null,
                RetentionUntil: retentionUntil), ct);
        }
        catch (MediaAssetConflictException)
        {
            logger.LogDebug("Auto audio already started for call {CallId}", call.Id);
            return;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Auto audio asset insert failed for call {CallId}", call.Id);
            audit.Append(call.ClinicId, call.Id, null, "system", "System",
                "ConsultationAudioStartFailed", "Failed", ex.Message);
            return;
        }

        try
        {
            await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, storageKey,
                mimeType: "audio/mpeg", bytes: null, etag: null,
                width: null, height: null, durationMs: null,
                bitrateKbps: null, codec: null, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Audio media_object placeholder failed for {AssetId}", assetId);
        }

        EgressResult result;
        try
        {
            result = await egress.StartRoomAudioRecordingAsync(
                call.RoomName, fileName, storageKey, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Auto audio Egress start failed for call {CallId}", call.Id);
            await catalog.TryMarkFailedAsync(assetId, null, ex.Message, ct);
            lock (call.SyncRoot) { call.AutoAudioStatus = "Failed"; }
            audit.Append(call.ClinicId, call.Id, assetId.ToString(), "system", "System",
                "ConsultationAudioStartFailed", "Failed", ex.Message);
            return;
        }

        await catalog.TryMarkRecordingAsync(assetId, result.EgressId, ct);
        lock (call.SyncRoot)
        {
            call.ConsultationSessionId = session.Id;
            call.AutoAudioStatus = "Recording";
        }
        audit.Append(call.ClinicId, call.Id, assetId.ToString(), "system", "System",
            "ConsultationAudioStarted", "Ok", result.EgressId);
    }

    /// <summary>
    /// Bounded stop — transitions to Finalizing, short StopEgress. Never awaits COMPLETE.
    /// </summary>
    public async Task StopAudioAsync(MediaAsset asset, CallSession call, CancellationToken ct = default)
    {
        if (!MediaAssetStatus.IsActive(asset.Status)) return;
        if (string.IsNullOrWhiteSpace(asset.EgressId)) return;

        try { await catalog.TryMarkFinalizingAsync(asset.Id, asset.EgressId, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "Audio Finalizing mark failed"); }

        lock (call.SyncRoot) { call.AutoAudioStatus = "Finalizing"; }

        try { await egress.RequestStopAsync(asset.EgressId, ct); }
        catch (Exception ex)
        {
            logger.LogWarning(ex,
                "StopEgress control failed for audio {EgressId} (staying Finalizing)", asset.EgressId);
        }

        audit.Append(call.ClinicId, call.Id, asset.Id.ToString(), "system", "System",
            "ConsultationAudioStopRequested", "Ok");
    }

    private static string Sanitize(string value)
    {
        var chars = value.Trim().Select(ch =>
            char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '-').ToArray();
        return new string(chars).ToLowerInvariant();
    }
}
