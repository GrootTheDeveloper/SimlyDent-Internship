using System.Text;
using System.Text.Json;

namespace LiveKitPoc.Api;

public sealed class SnapshotService(
    IConsultationCatalog catalog,
    IRecordingStorage storage,
    LiveKitRoomService roomService,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    IConfiguration configuration,
    ILogger<SnapshotService> logger)
{
    private int MaxUploadBytes =>
        int.TryParse(configuration["SNAPSHOT_MAX_BYTES"], out var n) && n > 0
            ? n
            : 15 * 1024 * 1024; // 15 MB default

    /// <summary>
    /// Staff requests capture. Backend sends targeted command to patient.
    /// Returns assetId only — uploadUrl is NOT returned to Staff.
    /// Local storage: uploadMode=api (patient POSTs bytes to API).
    /// S3 storage: uploadMode=presign (patient PUTs to Object Storage).
    /// </summary>
    public async Task<Guid> RequestCaptureAsync(
        CallSession call,
        TestIdentity staff,
        string patientParticipantIdentity,
        CancellationToken ct = default)
    {
        if (call.Status != CallStatus.Accepted)
            throw new InvalidOperationException("Call must be Accepted to request photo.");

        var session = await catalog.GetSessionByCallIdAsync(call.Id, ct)
                      ?? throw new InvalidOperationException(
                          "Consultation session not found. Accept call and grant consent first.");

        var policy = policies.Get(call.ClinicId);
        var assetId = Guid.NewGuid();
        var storageKey = MediaStorageKeys.PhotoOriginalKey(call.ClinicId, call.Id, assetId);
        var retentionUntil = DateTimeOffset.UtcNow.AddDays(policy.RetentionDays);

        assetId = await catalog.InsertMediaAssetAsync(new MediaAssetInsert(
            assetId, session.Id, call.Id, call.ClinicId,
            MediaAssetKinds.Snapshot, staff.Id,
            patientParticipantIdentity, SourceTrackId: null,
            RetentionUntil: retentionUntil), ct);

        await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, storageKey,
            mimeType: "image/jpeg", bytes: null, etag: null,
            width: null, height: null, durationMs: null,
            bitrateKbps: null, codec: null, ct);

        var putUrl = storage.CreatePresignedPutUrl(storageKey, TimeSpan.FromMinutes(5));
        var usePresign = !string.IsNullOrWhiteSpace(putUrl);

        await catalog.TryMarkUploadingAsync(assetId, ct);

        // Patient command: either direct S3 PUT or API upload (works with local disk).
        object commandPayload = usePresign
            ? new
            {
                type = "capture_photo",
                assetId = assetId.ToString("D"),
                uploadMode = "presign",
                uploadUrl = putUrl
            }
            : new
            {
                type = "capture_photo",
                assetId = assetId.ToString("D"),
                uploadMode = "api",
                uploadUrl = (string?)null,
                uploadPath = $"/api/media/{assetId:D}/upload"
            };

        var data = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(commandPayload));

        try
        {
            await roomService.SendDataToParticipantAsync(
                call.RoomName, patientParticipantIdentity, data, reliable: true, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "SendData capture_photo failed for asset {AssetId}", assetId);
            await catalog.TryMarkFailedAsync(assetId, null, "SendData failed: " + ex.Message, ct);
            throw new InvalidOperationException(
                "Không gửi được lệnh chụp tới bệnh nhân (kiểm tra camera/participant identity): " + ex.Message,
                ex);
        }

        audit.Append(call.ClinicId, call.Id, assetId.ToString(), staff.Id, staff.Role,
            "SnapshotRequested", "Ok",
            $"{patientParticipantIdentity};mode={(usePresign ? "presign" : "api")}");
        return assetId;
    }

    /// <summary>
    /// Patient uploads JPEG bytes via authenticated API (local storage / no presign).
    /// Bound to source_participant_id.
    /// </summary>
    public async Task<bool> ReceiveUploadAsync(
        Guid assetId,
        string callerParticipantIdentity,
        Stream content,
        long? contentLength,
        int? actualWidth,
        int? actualHeight,
        CancellationToken ct = default)
    {
        var asset = await catalog.GetAssetByIdAsync(assetId, ct);
        if (asset is null) return false;
        if (!IdentityMatches(asset.SourceParticipantId, callerParticipantIdentity))
            return false;
        if (asset.Kind != MediaAssetKinds.Snapshot) return false;
        if (asset.Status != MediaAssetStatus.Uploading) return false;

        var obj = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Original, ct);
        if (obj is null || string.IsNullOrWhiteSpace(obj.StorageKey)) return false;

        if (contentLength is <= 0)
        {
            await catalog.TryMarkFailedAsync(assetId, null, "Zero-byte upload.", ct);
            return false;
        }
        if (contentLength > MaxUploadBytes)
        {
            await catalog.TryMarkFailedAsync(assetId, null, $"Upload exceeds {MaxUploadBytes} bytes.", ct);
            return false;
        }

        await storage.SaveStreamAsync(obj.StorageKey, content, "image/jpeg", ct);

        if (!await storage.ExistsAsync(obj.StorageKey, ct))
            return false;

        var capturedAt = DateTimeOffset.UtcNow;
        var ready = await catalog.TryMarkSnapshotReadyAsync(assetId, capturedAt, ct);
        if (!ready) return false;

        await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, obj.StorageKey,
            mimeType: "image/jpeg", bytes: contentLength, etag: null,
            width: actualWidth, height: actualHeight, durationMs: null,
            bitrateKbps: null, codec: null, ct);
        await catalog.MarkMediaObjectReadyAsync(assetId, MediaObjectKinds.Original,
            contentLength, null, null, ct);

        audit.Append(asset.ClinicId, asset.CallId, assetId.ToString(), "system", "System",
            "SnapshotReady", "Ok", $"api-upload;{actualWidth}x{actualHeight}");
        return true;
    }

    /// <summary>
    /// Patient confirms upload after presigned PUT. HEAD + size.
    /// </summary>
    public async Task<bool> ConfirmUploadAsync(
        Guid assetId,
        string callerParticipantIdentity,
        int? actualWidth,
        int? actualHeight,
        long? reportedBytes,
        CancellationToken ct = default)
    {
        var asset = await catalog.GetAssetByIdAsync(assetId, ct);
        if (asset is null) return false;

        if (!IdentityMatches(asset.SourceParticipantId, callerParticipantIdentity))
        {
            logger.LogWarning(
                "Upload-complete rejected: caller {Caller} != source {Source} for {AssetId}",
                callerParticipantIdentity, asset.SourceParticipantId, assetId);
            return false;
        }

        if (asset.Kind != MediaAssetKinds.Snapshot) return false;
        if (asset.Status != MediaAssetStatus.Uploading) return false;

        var obj = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Original, ct);
        if (obj is null || string.IsNullOrWhiteSpace(obj.StorageKey)) return false;

        if (!await storage.ExistsAsync(obj.StorageKey, ct))
        {
            logger.LogInformation("Snapshot object not yet visible for {AssetId}", assetId);
            return false; // client retries
        }

        if (reportedBytes is <= 0)
        {
            await catalog.TryMarkFailedAsync(assetId, null, "Zero-byte upload.", ct);
            try { await storage.DeleteAsync(obj.StorageKey, ct); } catch { /* best effort */ }
            return false;
        }

        if (reportedBytes > MaxUploadBytes)
        {
            await catalog.TryMarkFailedAsync(assetId, null, $"Upload exceeds {MaxUploadBytes} bytes.", ct);
            try { await storage.DeleteAsync(obj.StorageKey, ct); } catch { /* best effort */ }
            audit.Append(asset.ClinicId, asset.CallId, assetId.ToString(), "system", "System",
                "SnapshotFailed", "Failed", "oversized");
            return false;
        }

        var capturedAt = DateTimeOffset.UtcNow;
        var ready = await catalog.TryMarkSnapshotReadyAsync(assetId, capturedAt, ct);
        if (!ready) return false;

        await catalog.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, obj.StorageKey,
            mimeType: "image/jpeg", bytes: reportedBytes, etag: null,
            width: actualWidth, height: actualHeight, durationMs: null,
            bitrateKbps: null, codec: null, ct);
        await catalog.MarkMediaObjectReadyAsync(assetId, MediaObjectKinds.Original,
            reportedBytes, null, null, ct);

        audit.Append(asset.ClinicId, asset.CallId, assetId.ToString(), "system", "System",
            "SnapshotReady", "Ok", $"{actualWidth}x{actualHeight}");
        return true;
    }

    private static bool IdentityMatches(string? source, string caller)
    {
        if (string.IsNullOrWhiteSpace(source) || string.IsNullOrWhiteSpace(caller))
            return false;
        if (string.Equals(source, caller, StringComparison.OrdinalIgnoreCase))
            return true;
        // Accept bare user id vs clinicId:userId
        if (source.EndsWith(":" + caller, StringComparison.OrdinalIgnoreCase))
            return true;
        if (caller.EndsWith(":" + source, StringComparison.OrdinalIgnoreCase))
            return true;
        return false;
    }
}
