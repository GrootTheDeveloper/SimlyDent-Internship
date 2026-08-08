using System.Collections.Concurrent;
using System.IO.Compression;
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
                    s.CallerId, FormatPatientDisplayName(s.CallerId, s.CallerDisplayName),
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

        // Manager: ZIP export — audio + videos/ + images/
        app.MapGet("/api/consultations/{sessionId:guid}/zip", async (
            Guid sessionId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            IRecordingStorage storage,
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
            var ready = assets
                .Where(a => MediaAssetStatus.IsDownloadable(a.Status))
                .OrderBy(a => a.RequestedAt)
                .ToList();
            if (ready.Count == 0)
                return Results.Conflict(new { error = "Chưa có media Ready để đóng gói." });

            // Stream ZIP via temp file — do not buffer entire package in RAM (large MP4s).
            // Media already compressed → NoCompression packaging.
            var tempPath = Path.Combine(Path.GetTempPath(), $"simlydent-zip-{sessionId:N}-{Guid.NewGuid():N}.zip");
            var fileCount = 0;
            try
            {
                await using (var fs = new FileStream(
                    tempPath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    bufferSize: 64 * 1024,
                    options: FileOptions.Asynchronous | FileOptions.SequentialScan))
                using (var zip = new ZipArchive(fs, ZipArchiveMode.Create, leaveOpen: true))
                {
                    var videoIdx = 0;
                    var photoIdx = 0;
                    foreach (var a in ready)
                    {
                        var obj = await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Playback, ct)
                                  ?? await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Original, ct);
                        if (obj is null || string.IsNullOrWhiteSpace(obj.StorageKey)) continue;
                        if (!await storage.ExistsAsync(obj.StorageKey, ct)) continue;

                        await using var stream = await storage.OpenReadAsync(obj.StorageKey, ct);
                        if (stream is null) continue;

                        string entryName;
                        if (a.Kind == MediaAssetKinds.CallAudio)
                            entryName = "audio.mp3";
                        else if (a.Kind == MediaAssetKinds.DentalVideoClip)
                        {
                            videoIdx++;
                            entryName = $"videos/clip-{videoIdx:D2}.mp4";
                        }
                        else if (a.Kind == MediaAssetKinds.Snapshot)
                        {
                            photoIdx++;
                            entryName = $"images/photo-{photoIdx:D2}.jpg";
                        }
                        else
                            entryName = $"other/{a.Kind.ToLowerInvariant()}-{a.Id:N}.bin";

                        var entry = zip.CreateEntry(entryName, CompressionLevel.NoCompression);
                        await using (var entryStream = entry.Open())
                        {
                            await stream.CopyToAsync(entryStream, 64 * 1024, ct);
                        }
                        fileCount++;
                    }
                }

                if (fileCount == 0)
                {
                    try { File.Delete(tempPath); } catch { /* ignore */ }
                    return Results.Conflict(new { error = "Không đọc được file media trên disk." });
                }

                var patient = FormatPatientDisplayName(session.CallerId, session.CallerDisplayName)
                    .Replace('#', '-')
                    .Replace(' ', '_');
                var zipName = $"consultation-{patient}-{session.CallId:N}.zip";
                // DeleteOnClose so temp is removed after response finishes streaming
                var readFs = new FileStream(
                    tempPath,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.Read,
                    bufferSize: 64 * 1024,
                    options: FileOptions.Asynchronous | FileOptions.SequentialScan | FileOptions.DeleteOnClose);
                return Results.File(readFs, "application/zip", fileDownloadName: zipName);
            }
            catch
            {
                try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { /* ignore */ }
                throw;
            }
        }).RequireAuthorization();

        return app;
    }

    /// <summary>
    /// Prefer sequential labels (Khách #1, #2) stored on session; never show visitor:{guid}.
    /// </summary>
    internal static string FormatPatientDisplayName(string? callerId, string? storedName)
    {
        // Sequential clinic order — preferred
        if (!string.IsNullOrWhiteSpace(storedName)
            && System.Text.RegularExpressions.Regex.IsMatch(storedName.Trim(), @"^Khách #\d+$"))
            return storedName.Trim();

        // Staff / known display names (not raw visitor ids)
        if (!string.IsNullOrWhiteSpace(storedName)
            && !string.Equals(storedName, callerId, StringComparison.OrdinalIgnoreCase)
            && !storedName.StartsWith("visitor:", StringComparison.OrdinalIgnoreCase)
            && !System.Text.RegularExpressions.Regex.IsMatch(storedName, @"^Khách #[0-9A-Fa-f]{4,}$"))
            return storedName;

        // Fallback short code (queue / pre-session) — not ideal but not a GUID
        return CallDispatcher.FormatCallerLabel(callerId);
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
            // Prefer Playback (canonical download) then Original — supports post-optimize Original delete.
            var obj = await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Playback, ct)
                      ?? await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Original, ct)
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
            FormatPatientDisplayName(session.CallerId, session.CallerDisplayName),
            session.StaffDisplayName,
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
