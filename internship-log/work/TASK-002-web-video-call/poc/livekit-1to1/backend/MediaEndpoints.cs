using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Authorization;

namespace LiveKitPoc.Api;

public static class MediaEndpoints
{
    public static IEndpointRouteBuilder MapMediaEndpoints(this IEndpointRouteBuilder app)
    {
        // Staff: start dental clip
        app.MapPost("/api/calls/{callId:guid}/video-clips/start", async (
            Guid callId,
            HttpRequest http,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            DentalClipService clipService,
            CallDispatcher dispatcher,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsStaff(current))
                return Results.Json(new { error = "Staff role required." }, statusCode: 403);

            var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, current);
            if (call is null) return Results.NotFound();

            StartDentalClipRequest? body;
            try
            {
                body = await http.ReadFromJsonAsync<StartDentalClipRequest>(
                    new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web),
                    cancellationToken: ct);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new
                {
                    error = "Invalid JSON body.",
                    detail = ex.Message
                });
            }

            if (body is null || string.IsNullOrWhiteSpace(body.PatientParticipantIdentity))
                return Results.BadRequest(new
                {
                    error = "patientParticipantIdentity required (LiveKit identity of patient camera)."
                });

            try
            {
                var (assetId, status) = await clipService.StartClipAsync(
                    call, current,
                    body.PatientParticipantIdentity.Trim(),
                    body.PatientVideoTrackSidHint,
                    body.WidthPx, body.HeightPx, ct);
                await dispatcher.NotifyCallAsync(call);
                return Results.Ok(new { assetId, status });
            }
            catch (MediaAssetConflictException ex)
            {
                return Results.Conflict(new { error = ex.Message });
            }
            catch (InvalidOperationException ex)
            {
                return Results.Conflict(new { error = ex.Message });
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 502);
            }
        }).RequireAuthorization();

        // Staff: stop dental clip
        app.MapPost("/api/calls/{callId:guid}/video-clips/{assetId:guid}/stop", async (
            Guid callId,
            Guid assetId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            DentalClipService clipService,
            CallDispatcher dispatcher,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsStaff(current))
                return Results.Json(new { error = "Staff role required." }, statusCode: 403);

            var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, current);
            if (call is null) return Results.NotFound();

            var ok = await clipService.StopClipAsync(call, assetId, current, ct);
            if (!ok) return Results.NotFound();
            await dispatcher.NotifyCallAsync(call);
            return Results.Ok(new { assetId, status = "Finalizing" });
        }).RequireAuthorization();

        // Staff: list clips for active call
        app.MapGet("/api/calls/{callId:guid}/video-clips", async (
            Guid callId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            IConsultationCatalog catalog,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, current);
            if (call is null) return Results.NotFound();

            var session = await catalog.GetSessionByCallIdAsync(callId, ct);
            if (session is null) return Results.Ok(new { items = Array.Empty<object>() });

            var assets = (await catalog.ListAssetsBySessionAsync(session.Id, ct))
                .Where(a => a.Kind == MediaAssetKinds.DentalVideoClip)
                .OrderBy(a => a.RequestedAt)
                .ToList();
            var idx = 0;
            var items = new List<MediaAssetDetailView>();
            foreach (var a in assets)
            {
                idx++;
                var obj = await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Original, ct);
                items.Add(ConsultationEndpoints.ToDetail(a, idx, obj));
            }
            return Results.Ok(new { items });
        }).RequireAuthorization();

        // Staff: request photo
        app.MapPost("/api/calls/{callId:guid}/photos/request", async (
            Guid callId,
            RequestPhotoBody? body,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            SnapshotService snapshotService,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsStaff(current))
                return Results.Json(new { error = "Staff role required." }, statusCode: 403);

            var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, current);
            if (call is null) return Results.NotFound();

            if (body is null || string.IsNullOrWhiteSpace(body.PatientParticipantIdentity))
                return Results.BadRequest(new { error = "patientParticipantIdentity required." });

            try
            {
                var assetId = await snapshotService.RequestCaptureAsync(
                    call, current, body.PatientParticipantIdentity, ct);
                // Staff only gets assetId — never uploadUrl
                return Results.Ok(new { assetId });
            }
            catch (InvalidOperationException ex)
            {
                return Results.Conflict(new { error = ex.Message });
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = ex.Message }, statusCode: 500);
            }
        }).RequireAuthorization();

        // Patient: binary JPEG upload (local storage / uploadMode=api)
        app.MapPost("/api/media/{assetId:guid}/upload", async (
            Guid assetId,
            HttpRequest request,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            SnapshotService snapshotService,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var candidates = CollectParticipantIdentities(principal, identities);
            if (candidates.Count == 0)
                return Results.Unauthorized();

            int? width = int.TryParse(request.Query["w"], out var w) ? w : null;
            int? height = int.TryParse(request.Query["h"], out var h) ? h : null;

            // Buffer body once — stream may be non-seekable.
            await using var ms = new MemoryStream();
            await request.Body.CopyToAsync(ms, ct);
            var len = ms.Length;
            if (len <= 0)
                return Results.BadRequest(new { error = "Empty body." });

            var ok = false;
            foreach (var identity in candidates)
            {
                ms.Position = 0;
                ok = await snapshotService.ReceiveUploadAsync(
                    assetId, identity, ms, len, width, height, ct);
                if (ok) break;
            }

            if (!ok)
                return Results.Conflict(new { error = "Upload rejected or not ready." });
            return Results.Ok(new { status = "Ready" });
        }).RequireAuthorization(new AuthorizeAttribute
        {
            AuthenticationSchemes =
                $"{JwtBearerDefaults.AuthenticationScheme},{EmbedAuthTokenService.AuthenticationScheme}"
        });

        // Patient (staff JWT participant or embed): confirm upload
        app.MapPost("/api/media/{assetId:guid}/upload-complete", async (
            Guid assetId,
            UploadCompleteBody? body,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            SnapshotService snapshotService,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var candidates = CollectParticipantIdentities(principal, identities);
            if (candidates.Count == 0)
                return Results.Unauthorized();

            var asset = await catalog.GetAssetByIdAsync(assetId, ct);
            if (asset is null) return Results.NotFound();

            var ok = false;
            foreach (var identity in candidates)
            {
                ok = await snapshotService.ConfirmUploadAsync(
                    assetId, identity,
                    body?.ActualWidth, body?.ActualHeight, body?.Bytes, ct);
                if (ok) break;
            }

            if (!ok)
            {
                // Distinguish not-found/forbidden vs retryable missing object
                asset = await catalog.GetAssetByIdAsync(assetId, ct);
                if (asset is null) return Results.NotFound();
                if (asset.Status == MediaAssetStatus.Failed)
                    return Results.Conflict(new { error = asset.Error ?? "Upload failed." });
                if (asset.Status == MediaAssetStatus.Ready)
                    return Results.Ok(new { status = "Ready" });
                return Results.Accepted(value: new { status = asset.Status, retry = true });
            }

            return Results.Ok(new { status = "Ready" });
        }).RequireAuthorization(new AuthorizeAttribute
        {
            AuthenticationSchemes =
                $"{JwtBearerDefaults.AuthenticationScheme},{EmbedAuthTokenService.AuthenticationScheme}"
        });

        // Active call media state (staff)
        app.MapGet("/api/calls/{callId:guid}/media-state", async (
            Guid callId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            IConsultationCatalog catalog,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetAuthorizedCall(calls, callId, current);
            if (call is null) return Results.NotFound();

            string audioStatus;
            string clipStatus;
            Guid? clipId;
            lock (call.SyncRoot)
            {
                audioStatus = call.AutoAudioStatus;
                clipStatus = call.ActiveDentalClipStatus;
                clipId = call.ActiveDentalClipAssetId;
            }

            var session = await catalog.GetSessionByCallIdAsync(callId, ct);
            var items = new List<MediaAssetDetailView>();
            if (session is not null)
            {
                var assets = await catalog.ListAssetsBySessionAsync(session.Id, ct);
                var i = 0;
                foreach (var a in assets.OrderBy(x => x.RequestedAt))
                {
                    i++;
                    var obj = await catalog.GetObjectByAssetAndKindAsync(a.Id, MediaObjectKinds.Original, ct);
                    items.Add(ConsultationEndpoints.ToDetail(a, i, obj));
                }
            }

            return Results.Ok(new MediaStateView(callId, audioStatus, clipStatus, clipId, items));
        }).RequireAuthorization();

        // Manager: download media
        app.MapGet("/api/media/{assetId:guid}/download-url", async (
            Guid assetId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            IRecordingStorage storage,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsManager(current))
                return Results.Json(new { error = "Manager role required." }, statusCode: 403);

            var asset = await catalog.GetAssetByIdAsync(assetId, ct);
            if (asset is null
                || !string.Equals(asset.ClinicId, current.ClinicId, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();

            if (!MediaAssetStatus.IsDownloadable(asset.Status))
                return Results.Conflict(new { error = "Media not ready for download." });

            var obj = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Playback, ct)
                      ?? await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Original, ct);
            if (obj is null || string.IsNullOrWhiteSpace(obj.StorageKey))
                return Results.NotFound();

            if (!await storage.ExistsAsync(obj.StorageKey, ct))
                return Results.Conflict(new { error = "Physical object missing." });

            var ttl = TimeSpan.FromMinutes(5);
            var presign = storage.CreatePresignedGetUrl(obj.StorageKey, ttl);
            if (!string.IsNullOrWhiteSpace(presign))
            {
                return Results.Ok(new
                {
                    url = presign,
                    expiresAt = DateTimeOffset.UtcNow.Add(ttl),
                    mode = "presign",
                    mimeType = obj.MimeType,
                    kind = asset.Kind
                });
            }

            // Local fallback proxy path
            return Results.Ok(new
            {
                url = $"/api/media/{assetId}/file",
                expiresAt = DateTimeOffset.UtcNow.Add(ttl),
                mode = "proxy",
                mimeType = obj.MimeType,
                kind = asset.Kind
            });
        }).RequireAuthorization();

        app.MapGet("/api/media/{assetId:guid}/file", async (
            Guid assetId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            IRecordingStorage storage,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsManager(current))
                return Results.Json(new { error = "Manager role required." }, statusCode: 403);

            var asset = await catalog.GetAssetByIdAsync(assetId, ct);
            if (asset is null
                || !string.Equals(asset.ClinicId, current.ClinicId, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();
            if (!MediaAssetStatus.IsDownloadable(asset.Status))
                return Results.Conflict(new { error = "Media not ready." });

            var obj = await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Playback, ct)
                      ?? await catalog.GetObjectByAssetAndKindAsync(assetId, MediaObjectKinds.Original, ct);
            if (obj is null || string.IsNullOrWhiteSpace(obj.StorageKey)) return Results.NotFound();

            var stream = await storage.OpenReadAsync(obj.StorageKey, ct);
            if (stream is null) return Results.NotFound();

            var contentType = obj.MimeType ?? asset.Kind switch
            {
                MediaAssetKinds.CallAudio => "audio/mpeg",
                MediaAssetKinds.DentalVideoClip => "video/mp4",
                MediaAssetKinds.Snapshot => "image/jpeg",
                _ => "application/octet-stream"
            };
            var ext = contentType switch
            {
                "audio/mpeg" => "mp3",
                "video/mp4" => "mp4",
                "image/jpeg" => "jpg",
                _ => "bin"
            };
            var downloadName = $"{asset.Kind.ToLowerInvariant()}-{assetId:N}.{ext}";
            return Results.File(stream, contentType, fileDownloadName: downloadName, enableRangeProcessing: true);
        }).RequireAuthorization();

        // Manager: mark delete pending only
        app.MapDelete("/api/media/{assetId:guid}", async (
            Guid assetId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IConsultationCatalog catalog,
            RecordingAuditService audit,
            IConfiguration config,
            CancellationToken ct) =>
        {
            if (!ConsultationEndpoints.IsMediaFeatureEnabled(config))
                return Results.NotFound();

            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsManager(current))
                return Results.Json(new { error = "Manager role required." }, statusCode: 403);

            var asset = await catalog.GetAssetByIdAsync(assetId, ct);
            if (asset is null
                || !string.Equals(asset.ClinicId, current.ClinicId, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();

            var claimed = await catalog.TryMarkDeletePendingAsync(assetId, ct);
            if (!claimed)
                return Results.Conflict(new { error = "Only Ready media can be marked for deletion." });

            audit.Append(asset.ClinicId, asset.CallId, assetId.ToString(), current.Id, current.Role,
                "MediaDeleteRequested", "Ok");
            return Results.Ok(new { status = MediaAssetStatus.DeletePending });
        }).RequireAuthorization();

        return app;
    }

    private static List<string> CollectParticipantIdentities(
        ClaimsPrincipal principal,
        IdentityRegistry identities)
    {
        var candidates = new List<string>();
        var current = ClinicAuthorization.CurrentUser(principal, identities);
        if (current is not null)
        {
            candidates.Add($"{current.ClinicId}:{current.Id}");
            candidates.Add(current.Id);
        }

        var embed = EmbedAuthTokenService.TryReadSession(principal);
        if (embed is not null)
        {
            candidates.Add($"visitor:{embed.SessionId}");
            candidates.Add($"{embed.ClinicId}:visitor:{embed.SessionId}");
            if (!string.IsNullOrWhiteSpace(embed.VisitorId))
            {
                candidates.Add(embed.VisitorId);
                candidates.Add($"{embed.ClinicId}:{embed.VisitorId}");
            }
        }

        var sub = principal.FindFirstValue("sub")
                  ?? principal.FindFirstValue(ClaimTypes.NameIdentifier);
        var clinicClaim = principal.FindFirstValue("clinic_id")
                          ?? principal.FindFirstValue("clinicId");
        if (!string.IsNullOrWhiteSpace(sub))
        {
            candidates.Add(sub);
            if (!string.IsNullOrWhiteSpace(clinicClaim))
                candidates.Add($"{clinicClaim}:{sub}");
        }

        return candidates
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }
}
