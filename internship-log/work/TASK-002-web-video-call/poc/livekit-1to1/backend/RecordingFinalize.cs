namespace LiveKitPoc.Api;

/// <summary>
/// Shared finalize: ensure recording object exists after Egress COMPLETE.
/// Local: copy from egress /out into IRecordingStorage.
/// Direct S3 (EGRESS_OUTPUT=s3): Egress already uploaded — only HeadObject via ExistsAsync.
/// </summary>
public static class RecordingFinalize
{
    public static async Task<string> MaterializeObjectAsync(
        LiveKitEgressService egress,
        IRecordingStorage storage,
        string clinicId,
        Guid callId,
        string recordingId,
        string fileName,
        CancellationToken cancellationToken)
    {
        var key = storage.BuildKey(clinicId, callId, recordingId, "mp4");

        if (egress.UsesDirectS3Output)
        {
            // Bytes path: LiveKit → Egress Worker → Object Storage. API never PutObject the video body.
            if (!await storage.ExistsAsync(key, cancellationToken))
            {
                // Brief retry — S3 listing/eventual consistency on some fixtures.
                for (var i = 0; i < 10 && !await storage.ExistsAsync(key, cancellationToken); i++)
                    await Task.Delay(300, cancellationToken);
            }
            if (!await storage.ExistsAsync(key, cancellationToken))
                throw new InvalidOperationException(
                    "Egress completed but object was not found in storage (direct S3 path).");
            return key;
        }

        var localPath = egress.GetLocalEgressPath(fileName);
        if (!File.Exists(localPath))
            throw new InvalidOperationException("Egress completed but the recording file was not found.");
        await storage.SaveFromLocalFileAsync(key, localPath, cancellationToken);
        if (!await storage.ExistsAsync(key, cancellationToken))
            throw new InvalidOperationException("Archive to storage failed (object missing after save).");
        return key;
    }
}
