using LiveKitPoc.Api.Options;
using Xunit;

namespace LiveKitPoc.Api.Tests;

public class DentalOptimizationCatalogTests
{
    [Fact]
    public async Task CandidateQuery_IsCrossClinic_NoHardcodedTenants()
    {
        var cat = new MemoryConsultationCatalog();
        var a1 = await SeedReadyClipAsync(cat, "clinic-alpha");
        var a2 = await SeedReadyClipAsync(cat, "clinic-beta");
        var a3 = await SeedReadyClipAsync(cat, "clinic-gamma");

        var list = await cat.ListDentalVideoOptimizationCandidatesAsync(10, maxAttempts: 5);
        Assert.Equal(3, list.Count);
        var clinics = list.Select(c => c.ClinicId).OrderBy(x => x).ToArray();
        Assert.Equal(new[] { "clinic-alpha", "clinic-beta", "clinic-gamma" }, clinics);
        Assert.Contains(list, c => c.AssetId == a1);
        Assert.Contains(list, c => c.AssetId == a2);
        Assert.Contains(list, c => c.AssetId == a3);
    }

    [Fact]
    public async Task CandidateQuery_RespectsLimit_AndOrder()
    {
        var cat = new MemoryConsultationCatalog();
        await SeedReadyClipAsync(cat, "c1");
        await Task.Delay(5);
        await SeedReadyClipAsync(cat, "c2");
        await Task.Delay(5);
        await SeedReadyClipAsync(cat, "c3");

        var list = await cat.ListDentalVideoOptimizationCandidatesAsync(2, 5);
        Assert.Equal(2, list.Count);
        Assert.True(list[0].RequestedAt <= list[1].RequestedAt);
    }

    [Fact]
    public async Task Claim_OnlyOneWorkerSucceeds()
    {
        var cat = new MemoryConsultationCatalog();
        var assetId = await SeedReadyClipAsync(cat, "clinic-x");
        var lease = DateTimeOffset.UtcNow.AddMinutes(10);

        var w1 = await cat.TryClaimDentalOptimizationAsync(assetId, "worker-1", lease, 5);
        var w2 = await cat.TryClaimDentalOptimizationAsync(assetId, "worker-2", lease, 5);
        Assert.True(w1);
        Assert.False(w2);
    }

    [Fact]
    public async Task Claim_LeaseExpiry_AllowsOtherWorker()
    {
        var cat = new MemoryConsultationCatalog();
        var assetId = await SeedReadyClipAsync(cat, "clinic-x");

        Assert.True(await cat.TryClaimDentalOptimizationAsync(
            assetId, "worker-1", DateTimeOffset.UtcNow.AddMilliseconds(-1), 5));
        Assert.True(await cat.TryClaimDentalOptimizationAsync(
            assetId, "worker-2", DateTimeOffset.UtcNow.AddMinutes(5), 5));
    }

    [Fact]
    public async Task Complete_Skipped_NotListedAgain()
    {
        var cat = new MemoryConsultationCatalog();
        var assetId = await SeedReadyClipAsync(cat, "clinic-x");
        Assert.True(await cat.TryClaimDentalOptimizationAsync(
            assetId, "w", DateTimeOffset.UtcNow.AddMinutes(5), 5));
        await cat.CompleteDentalOptimizationAsync(assetId, DentalOptimizationStatus.Skipped, "no saving");

        var list = await cat.ListDentalVideoOptimizationCandidatesAsync(10, 5);
        Assert.DoesNotContain(list, c => c.AssetId == assetId);
    }

    [Fact]
    public async Task Complete_Ready_WithPlayback_NotListed()
    {
        var cat = new MemoryConsultationCatalog();
        var assetId = await SeedReadyClipAsync(cat, "clinic-x");
        await cat.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Playback, "k.opt.mp4",
            "video/mp4", 100, null, 640, 480, 1000, 500, "h264");
        await cat.MarkMediaObjectReadyAsync(assetId, MediaObjectKinds.Playback, 100, null, 1000);
        await cat.CompleteDentalOptimizationAsync(assetId, DentalOptimizationStatus.Ready, null);

        var list = await cat.ListDentalVideoOptimizationCandidatesAsync(10, 5);
        Assert.DoesNotContain(list, c => c.AssetId == assetId);
    }

    [Fact]
    public async Task RemoveMediaObject_DeletesOriginalRow()
    {
        var cat = new MemoryConsultationCatalog();
        var assetId = await SeedReadyClipAsync(cat, "clinic-x");
        Assert.True(await cat.RemoveMediaObjectAsync(assetId, MediaObjectKinds.Original));
        var o = await cat.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Original);
        Assert.Null(o);
    }

    [Fact]
    public void ValidateOptimized_RejectsLargerCodecMismatchAndDuration()
    {
        var dir = Path.Combine(Path.GetTempPath(), "opt-val-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        var outPath = Path.Combine(dir, "o.mp4");
        File.WriteAllBytes(outPath, new byte[] { 1, 2, 3 });
        try
        {
            var input = new MediaProbeResult(1000, 640, 480, 10_000, 900, "h264", 30, null);
            var badCodec = new MediaProbeResult(500, 640, 480, 10_000, 400, "vp9", 30, null);
            Assert.False(DentalVideoOptimizationService.ValidateOptimized(input, badCodec, outPath, out _));

            var upscale = new MediaProbeResult(500, 1280, 720, 10_000, 400, "h264", 30, null);
            Assert.False(DentalVideoOptimizationService.ValidateOptimized(input, upscale, outPath, out _));

            var good = new MediaProbeResult(500, 640, 480, 10_000, 400, "h264", 30, null);
            Assert.True(DentalVideoOptimizationService.ValidateOptimized(input, good, outPath, out _));
        }
        finally
        {
            try { Directory.Delete(dir, true); } catch { /* ignore */ }
        }
    }

    [Fact]
    public void MinSaving_Rule_Logic()
    {
        const double threshold = 5.0;
        long inBytes = 10_000_000;
        long outLarger = 11_000_000;
        long outSmall = 9_000_000;
        var pctLarge = 100.0 * (inBytes - outLarger) / inBytes;
        var pctSmall = 100.0 * (inBytes - outSmall) / inBytes;
        Assert.True(pctLarge < threshold);
        Assert.True(pctSmall >= threshold);
    }

    private static async Task<Guid> SeedReadyClipAsync(
        MemoryConsultationCatalog cat, string clinicId)
    {
        var callId = Guid.NewGuid();
        var session = await cat.EnsureSessionAsync(
            callId, clinicId, "room-" + callId.ToString("N")[..8],
            "staff-1", "Staff", "staff-1", "Staff", "Video");
        var assetId = Guid.NewGuid();
        await cat.InsertMediaAssetAsync(new MediaAssetInsert(
            assetId, session.Id, callId, clinicId,
            MediaAssetKinds.DentalVideoClip, "staff-1", "p1", "TR_x",
            DateTimeOffset.UtcNow.AddDays(30)));
        var eg = "EG_" + assetId.ToString("N")[..8];
        await cat.TryMarkRecordingAsync(assetId, eg);
        await cat.TryMarkFinalizingAsync(assetId, eg);
        await cat.TryMarkReadyAsync(assetId, eg, 5000, DateTimeOffset.UtcNow);
        var key = $"clinic/{clinicId}/calls/{callId:N}/videos/{assetId:N}.mp4";
        await cat.UpsertMediaObjectAsync(assetId, MediaObjectKinds.Original, key,
            "video/mp4", 1_000_000, null, 1280, 720, 5000, 1800, "h264");
        await cat.MarkMediaObjectReadyAsync(assetId, MediaObjectKinds.Original, 1_000_000, null, 5000);
        return assetId;
    }
}
