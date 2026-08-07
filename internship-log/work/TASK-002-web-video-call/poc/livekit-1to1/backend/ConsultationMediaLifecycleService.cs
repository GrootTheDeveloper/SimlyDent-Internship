namespace LiveKitPoc.Api;

/// <summary>
/// On call end: stop audio + any active dental clip. Bounded await; never blocks End.
/// </summary>
public sealed class ConsultationMediaLifecycleService(
    IConsultationCatalog catalog,
    ConsultationAudioService audioService,
    DentalClipService clipService,
    ILogger<ConsultationMediaLifecycleService> logger)
{
    public async Task StopAllActiveMediaAsync(CallSession call, CancellationToken ct = default)
    {
        IReadOnlyList<MediaAsset> active;
        try
        {
            active = await catalog.ListActiveAssetsByCallAsync(call.Id, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "ListActiveAssets failed on call end {CallId}", call.Id);
            return;
        }

        foreach (var asset in active)
        {
            try
            {
                switch (asset.Kind)
                {
                    case MediaAssetKinds.CallAudio:
                        await audioService.StopAudioAsync(asset, call, ct);
                        break;
                    case MediaAssetKinds.DentalVideoClip:
                        await clipService.StopClipCoreAsync(asset, call, ct);
                        break;
                    // Snapshot Uploading: leave Uploading; reconcile/confirm handles it
                }
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex,
                    "Stop active media {Kind} {AssetId} failed on call end", asset.Kind, asset.Id);
            }
        }

        try { await catalog.MarkSessionEndedAsync(call.Id, ct); }
        catch (Exception ex) { logger.LogWarning(ex, "MarkSessionEnded failed for {CallId}", call.Id); }
    }
}
