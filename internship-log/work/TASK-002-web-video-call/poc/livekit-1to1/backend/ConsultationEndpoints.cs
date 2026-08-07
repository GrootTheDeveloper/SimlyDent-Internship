using System.Collections.Concurrent;
using System.Security.Claims;

namespace LiveKitPoc.Api;

public static class ConsultationEndpoints
{
    public static IEndpointRouteBuilder MapConsultationEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/consultations", async (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            IConfiguration config,
            int? limit,
            int? offset,
            CancellationToken ct) =>
        {
            if (!IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsManager(current))
                return Results.Json(new { error = "Manager role required." }, statusCode: 403);

            var take = Math.Clamp(limit ?? 50, 1, 200);
            var skip = Math.Max(0, offset ?? 0);
            var sessions = await catalog.ListSessionsByClinicAsync(current.ClinicId, take, skip, ct);
            var items = new List<ConsultationListItem>();
            foreach (var s in sessions)
            {
                var counts = await catalog.GetMediaCountsAsync(s.Id, ct);
                var duration = 0;
                if (s.StartedAt is not null)
                {
                    var end = s.EndedAt ?? DateTimeOffset.UtcNow;
                    duration = (int)Math.Max(0, (end - s.StartedAt.Value).TotalSeconds);
                }
                items.Add(new ConsultationListItem(
                    s.Id, s.CallId, s.ClinicId,
                    s.CallerId, s.CallerDisplayName,
                    s.StaffId, s.StaffDisplayName,
                    s.StartedAt, s.EndedAt, duration,
                    counts.audio, counts.video, counts.photo,
                    s.Status));
            }

            return Results.Ok(new { items, total = items.Count });
        }).RequireAuthorization();

        app.MapGet("/api/consultations/{sessionId:guid}", async (
            Guid sessionId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsManager(current))
                return Results.Json(new { error = "Manager role required." }, statusCode: 403);

            var session = await catalog.GetSessionByIdAsync(sessionId, ct);
            if (session is null
                || !string.Equals(session.ClinicId, current.ClinicId, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();

            var assets = await catalog.ListAssetsBySessionAsync(sessionId, ct);
            var detail = await BuildDetailViewAsync(session, assets, catalog, ct);
            return Results.Ok(detail);
        }).RequireAuthorization();

        return app;
    }

    internal static async Task<ConsultationDetailView> BuildDetailViewAsync(
        ConsultationSession session,
        IReadOnlyList<MediaAsset> assets,
        IConsultationCatalog catalog,
        CancellationToken ct)
    {
        MediaAssetDetailView? audio = null;
        var clips = new List<MediaAssetDetailView>();
        var photos = new List<MediaAssetDetailView>();
        var clipIdx = 0;
        var photoIdx = 0;

        foreach (var a in assets.OrderBy(x => x.RequestedAt))
        {
            var obj = await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Original, ct)
                      ?? (await catalog.GetObjectsByAssetAsync(a.Id, ct)).FirstOrDefault();
            if (a.Kind == MediaAssetKinds.CallAudio)
            {
                audio = ToDetail(a, 1, obj);
            }
            else if (a.Kind == MediaAssetKinds.DentalVideoClip)
            {
                clipIdx++;
                clips.Add(ToDetail(a, clipIdx, obj));
            }
            else if (a.Kind == MediaAssetKinds.Snapshot)
            {
                photoIdx++;
                photos.Add(ToDetail(a, photoIdx, obj));
            }
        }

        return new ConsultationDetailView(
            session.Id, session.CallId,
            session.CallerDisplayName, session.StaffDisplayName,
            session.StartedAt, session.EndedAt,
            audio, clips, photos);
    }

    internal static MediaAssetDetailView ToDetail(MediaAsset a, int displayIndex, MediaObject? obj) =>
        new(
            a.Id, a.Kind, a.Status, displayIndex,
            a.StartedAt, a.EndedAt, a.CapturedAt,
            obj?.DurationMs, obj?.Bytes, obj?.Width, obj?.Height, obj?.MimeType,
            a.Label, a.Note, a.Error,
            MediaAssetStatus.IsDownloadable(a.Status),
            a.Status == MediaAssetStatus.Ready);

    internal static bool IsMediaFeatureEnabled(IConfiguration config)
    {
        var raw = config["FEATURE_MEDIA_ASSETS"];
        if (string.IsNullOrWhiteSpace(raw)) return true; // default on
        return !string.Equals(raw, "0", StringComparison.OrdinalIgnoreCase)
               && !string.Equals(raw, "false", StringComparison.OrdinalIgnoreCase)
               && !string.Equals(raw, "off", StringComparison.OrdinalIgnoreCase);
    }
}
