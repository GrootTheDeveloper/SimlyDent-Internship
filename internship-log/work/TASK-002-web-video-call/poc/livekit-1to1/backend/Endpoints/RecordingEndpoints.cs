using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

using Microsoft.Extensions.Logging;

namespace LiveKitPoc.Api;

public static class RecordingEndpoints
{
    public static IEndpointRouteBuilder MapRecordingEndpoints(this IEndpointRouteBuilder app)
    {
        var endpointLogger = LoggerFactory.Create(b => b.AddConsole()).CreateLogger("Endpoints");
        app.MapGet("/api/recordings", async (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            RecordingPolicyRegistry policies,
            IRecordingCatalog catalog,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = RecordingAuthorization.RequireManager(current);
            if (denied is not null) return denied;

            var clinicId = current!.ClinicId;
            var policy = policies.Get(clinicId);

            static string CallerLabel(string? callerId)
            {
                if (string.IsNullOrWhiteSpace(callerId)) return "—";
                if (callerId.StartsWith("visitor:", StringComparison.OrdinalIgnoreCase))
                {
                    var raw = callerId["visitor:".Length..].Replace("-", "");
                    var code = raw.Length >= 6 ? raw[..6].ToUpperInvariant() : raw.ToUpperInvariant();
                    return $"Khách #{code}";
                }
                if (callerId.Length <= 8 && char.IsLetter(callerId[0])) return callerId;
                return callerId;
            }

            // Prefer durable catalog so Manager library survives API restart.
            var catalogRows = await catalog.ListByClinicAsync(clinicId, cancellationToken);
            if (catalogRows.Count > 0 || catalog.BackendName is "postgres")
            {
                var items = catalogRows.Select(r =>
                {
                    var uiStatus = RecordingLedgerStatus.ToUiStatus(r.Status);
                    var canDownload = RecordingLedgerStatus.IsDownloadable(r.Status)
                                      && !string.IsNullOrWhiteSpace(r.StorageKey);
                    var canDelete = r.Status is RecordingLedgerStatus.Deleted
                                    || (r.Status is RecordingLedgerStatus.Ready or RecordingLedgerStatus.Failed
                                        && !string.IsNullOrWhiteSpace(r.StorageKey));
                    return new RecordingListItem(
                        r.CallId,
                        r.Id,
                        r.CallerId ?? "",
                        CallerLabel(r.CallerId),
                        r.AssignedStaffId,
                        r.CallStatus ?? "—",
                        r.Mode,
                        uiStatus,
                        r.ConsentStatus ?? "—",
                        r.CreatedAt,
                        r.UpdatedAt,
                        canDownload,
                        canDelete);
                }).ToList();
                return Results.Ok(new RecordingListResponse(items, items.Count));
            }

            // Memory catalog empty: fall back to live call sessions (lab without prior starts).
            static bool IsLibraryRow(CallSession c) =>
                c.RecordingStatus is not ("Idle" or "")
                || !string.IsNullOrWhiteSpace(c.RecordingStorageKey)
                || c.RecordingMode != RecordingMode.None;

            var fallback = calls.Values
                .Where(c => c.BelongsToClinic(clinicId) && IsLibraryRow(c))
                .OrderByDescending(c => c.UpdatedAt)
                .Select(c =>
                {
                    var view = RecordingAuthorization.BuildView(c, current, policy);
                    return new RecordingListItem(
                        c.Id,
                        c.RecordingId,
                        c.CallerId,
                        CallerLabel(c.CallerId),
                        c.AssignedStaffId ?? c.CalleeId,
                        c.Status.ToString(),
                        c.RecordingMode.ToString(),
                        c.RecordingStatus,
                        c.ConsentStatus.ToString(),
                        c.CreatedAt,
                        c.UpdatedAt,
                        view.CanDownload,
                        view.CanDelete);
                })
                .ToList();

            return Results.Ok(new RecordingListResponse(fallback, fallback.Count));
        }).RequireAuthorization();


        app.MapGet("/api/recording/audit", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            RecordingAuditService audit) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = RecordingAuthorization.RequireManager(current);
            if (denied is not null) return denied;
            return Results.Ok(audit.Snapshot(current!.ClinicId));
        }).RequireAuthorization();


        app.MapPost("/api/admin/recording/retention-run", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            RecordingRetentionService retention) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = RecordingAuthorization.RequireManager(current);
            if (denied is not null) return denied;
            var n = retention.RunOnce();
            return Results.Ok(new { deleted = n });
        }).RequireAuthorization();


        app.MapGet("/api/calls/{id:guid}/recording", (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            RecordingPolicyRegistry policies) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!calls.TryGetValue(id, out var call) || !call.BelongsToClinic(current.ClinicId))
                return Results.NotFound();
            if (!RecordingAuthorization.CanViewBusinessState(current, call)
                && ClinicAuthorization.GetAuthorizedCall(calls, id, current) is null
                && RecordingAuthorization.GetClinicCallForManager(calls, id, current) is null)
                return Results.NotFound();
            var policy = policies.Get(call.ClinicId);
            return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/recording/mode", (
            Guid id,
            SetRecordingModeRequest body,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            RecordingPolicyRegistry policies,
            CallDispatcher dispatcher) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
            if (call is null) return Results.NotFound();
            if (!RecordingAuthorization.CanStartStop(current, call))
                return Results.Json(new { error = "Only call staff may set recording mode." }, statusCode: 403);
            if (!Enum.TryParse<RecordingMode>(body.Mode, ignoreCase: true, out var mode))
                return Results.BadRequest(new { error = "Invalid mode. Use None, AudioOnly, or Video." });
            var policy = policies.Get(call.ClinicId);
            if (!policy.IsModeAllowed(mode))
                return Results.Json(new { error = "Mode not allowed by clinic policy." }, statusCode: 403);
            lock (call.SyncRoot)
            {
                if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
                    return Results.Conflict(new { error = "Cannot change mode while recording is active." });
                call.RecordingMode = mode;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
            _ = dispatcher.NotifyCallAsync(call);
            return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/recording/consent", async (
            Guid id,
            SetConsentRequest body,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            RecordingPolicyRegistry policies,
            RecordingAuditService audit,
            CallDispatcher dispatcher,
            ConsultationAudioService audioService,
            IConsultationCatalog consultationCatalog,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
            if (call is null) return Results.NotFound();
            if (!Enum.TryParse<ConsentStatus>(body.Status, ignoreCase: true, out var consent)
                || consent == ConsentStatus.Pending)
                return Results.BadRequest(new { error = "Status must be Granted or Declined." });
            var policy = policies.Get(call.ClinicId);
            lock (call.SyncRoot)
            {
                call.ConsentStatus = consent;
                call.ConsentActorId = current.Id;
                call.ConsentPolicyVersion = policy.Version;
                call.ConsentGrantedAt = consent == ConsentStatus.Granted ? DateTimeOffset.UtcNow : null;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
            audit.Append(call.ClinicId, call.Id, call.RecordingId, current.Id, current.Role,
                consent == ConsentStatus.Granted ? "ConsentGranted" : "ConsentDeclined", "Ok");

            if (consent == ConsentStatus.Granted && call.Status == CallStatus.Accepted)
            {
                try
                {
                    if (await consultationCatalog.GetSessionByCallIdAsync(call.Id, cancellationToken) is null)
                    {
                        var caller = identities.Find(call.CallerId);
                        var staff = identities.Find(call.AssignedStaffId ?? call.CalleeId ?? current.Id);
                        await consultationCatalog.EnsureSessionAsync(
                            call.Id, call.ClinicId, call.RoomName,
                            call.CallerId, caller?.DisplayName ?? call.CallerId,
                            staff?.Id ?? current.Id, staff?.DisplayName ?? current.DisplayName,
                            "Audio", cancellationToken);
                    }
                    await audioService.EnsureAutoAudioStartedAsync(call, cancellationToken);
                }
                catch (Exception ex)
                {
                    endpointLogger.LogWarning(ex, "Auto audio after consent failed for {CallId}", call.Id);
                }
            }

            _ = dispatcher.NotifyCallAsync(call);
            return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
        }).RequireAuthorization();


        // LEGACY path ? see docs/media-paths.md; prefer consultation CallAudio.
        app.MapPost("/api/calls/{id:guid}/recording/start", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            RecordingOrchestrationService orchestration,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            return await orchestration.StartLegacyRecordingAsync(id, current, cancellationToken);
        }).RequireAuthorization();

        /// Async stop: Finalizing + short StopEgress control call; Ready via webhook/reconcile.
        /// Transport errors keep Finalizing (not Failed).
        /// </summary>


        /// <summary>LEGACY async stop ? Finalizing; Ready via webhook/reconcile.</summary>
        app.MapPost("/api/calls/{id:guid}/recording/stop", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            RecordingOrchestrationService orchestration,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            return await orchestration.StopLegacyRecordingAsync(id, current, cancellationToken);
        }).RequireAuthorization();

        /// LiveKit webhook (raw body JWT + sha256). Prefer egress_ended → finalize service.
        /// </summary>


        app.MapPost("/api/calls/{id:guid}/recording/plant-complete", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            IRecordingStorage storage,
            IRecordingCatalog catalog,
            RecordingPolicyRegistry policies,
            RecordingAuditService audit,
            CallDispatcher dispatcher,
            PlantRecordingRequest? body,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = RecordingAuthorization.GetClinicCallForManager(calls, id, current);
            if (call is null) return Results.NotFound();

            lock (call.SyncRoot)
            {
                if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
                    return Results.Conflict(new { error = "Cannot plant over an active recording." });
            }

            var recId = Guid.NewGuid().ToString("N");
            var key = storage.BuildKey(call.ClinicId, call.Id, recId, "mp4");
            var tmp = Path.Combine(Path.GetTempPath(), $"plant-{recId}.mp4");
            await File.WriteAllBytesAsync(tmp, System.Text.Encoding.UTF8.GetBytes(
                "simlydent-poc-planted-recording\n" + call.Id.ToString("N") + "\n"), cancellationToken);
            try
            {
                await storage.SaveFromLocalFileAsync(key, tmp, cancellationToken);
            }
            finally
            {
                try { File.Delete(tmp); } catch { /* ignore */ }
            }

            if (!await storage.ExistsAsync(key, cancellationToken))
                return Results.Json(new { error = "Plant failed: object missing after save." }, statusCode: 503);

            var ageDays = body?.AgeDays ?? 0;
            var updatedAt = ageDays > 0
                ? DateTimeOffset.UtcNow.AddDays(-ageDays)
                : DateTimeOffset.UtcNow;
            var policy = policies.Get(call.ClinicId);
            var mode = call.RecordingMode == RecordingMode.None ? RecordingMode.Video : call.RecordingMode;
            var retentionUntil = updatedAt.AddDays(policy.RetentionDays);

            try
            {
                var plantEgress = "plant-" + recId;
                await catalog.InsertRequestedAsync(
                    recId, call.ClinicId, call.Id, mode.ToString(), key, "Composite",
                    retentionUntil, call.CallerId, call.AssignedStaffId ?? call.CalleeId,
                    call.Status.ToString(), call.ConsentStatus.ToString(), fileName: null, cancellationToken);
                await catalog.TryMarkRecordingAsync(recId, plantEgress, cancellationToken);
                await catalog.TryMarkReadyAsync(recId, plantEgress, key, cancellationToken: cancellationToken);
            }
            catch (Exception ex)
            {
                return Results.Json(new { error = $"Plant catalog failed: {ex.Message}" }, statusCode: 503);
            }

            lock (call.SyncRoot)
            {
                call.RecordingMode = mode;
                call.RecordingId = recId;
                call.RecordingStorageKey = key;
                call.RecordingStatus = "Complete";
                call.UpdatedAt = updatedAt;
            }

            audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
                "RecordingStopped", "Ok", "plant-complete");
            await dispatcher.NotifyCallAsync(call);
            return Results.Ok(new
            {
                storageKey = key,
                recording = RecordingAuthorization.BuildView(call, current, policy)
            });
        }).RequireAuthorization();

        /// <summary>
        /// Issue temporary download capability. Catalog is authority (works after API restart).
        /// mode=presign → browser hits Object Storage; mode=proxy → relative file stream URL.
        /// Audit: RecordingDownloadUrlIssued (does not prove bytes were fetched).
        /// </summary>


        app.MapGet("/api/calls/{callId:guid}/recording/download-url", async (
            Guid callId,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IRecordingStorage storage,
            IRecordingCatalog catalog,
            RecordingAuditService audit,
            IConfiguration configuration,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var denied = RecordingAuthorization.RequireManager(current);
            if (denied is not null) return denied;

            var ledger = await catalog.GetLatestByCallAsync(callId, cancellationToken);
            if (ledger is null
                || !string.Equals(ledger.ClinicId, current!.ClinicId, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();

            if (!RecordingLedgerStatus.IsDownloadable(ledger.Status)
                || string.IsNullOrWhiteSpace(ledger.StorageKey))
                return Results.Conflict(new { error = "Recording is not ready." });

            var ttlSec = 300;
            if (int.TryParse(configuration["RECORDING_PRESIGN_TTL_SECONDS"], out var t) && t > 0)
                ttlSec = Math.Min(t, 900);
            var ttl = TimeSpan.FromSeconds(ttlSec);
            var expiresAt = DateTimeOffset.UtcNow.Add(ttl);

            string mode;
            string url;
            if (storage.SupportsPresignedGet)
            {
                var signed = storage.CreatePresignedGetUrl(ledger.StorageKey!, ttl);
                if (string.IsNullOrWhiteSpace(signed))
                    return Results.Json(new { error = "Presign unavailable." }, statusCode: 503);
                mode = "presign";
                url = signed;
            }
            else
            {
                mode = "proxy";
                url = $"/api/calls/{callId:D}/recording/file";
            }

            // Never put full signed URL in audit detail.
            audit.Append(ledger.ClinicId, ledger.CallId, ledger.Id, current.Id, current.Role,
                "RecordingDownloadUrlIssued", "Ok", $"mode={mode};ttlSec={ttlSec}");

            return Results.Ok(new
            {
                url,
                expiresAt,
                mode,
                recordingId = ledger.Id,
                callId = ledger.CallId
            });
        }).RequireAuthorization();

        /// <summary>
        /// Proxy stream path — only when mode=proxy or scripts. Catalog authority.
        /// Audit RecordingDownloaded only when bytes leave this endpoint.
        /// </summary>


        app.MapGet("/api/calls/{id:guid}/recording/file", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            IRecordingStorage storage,
            IRecordingCatalog catalog,
            RecordingAuditService audit,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var denied = RecordingAuthorization.RequireManager(current);
            if (denied is not null) return denied;

            var ledger = await catalog.GetLatestByCallAsync(id, cancellationToken);
            if (ledger is null
                || !string.Equals(ledger.ClinicId, current!.ClinicId, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();

            if (!RecordingLedgerStatus.IsDownloadable(ledger.Status)
                || string.IsNullOrWhiteSpace(ledger.StorageKey))
                return Results.Conflict(new { error = "Recording is not ready." });

            var stream = await storage.OpenReadAsync(ledger.StorageKey!, cancellationToken);
            if (stream is null)
            {
                audit.Append(ledger.ClinicId, ledger.CallId, ledger.Id, current.Id, current.Role,
                    "RecordingDownloaded", "Failed", "missing object");
                return Results.NotFound(new { error = "Recording file was not found." });
            }

            audit.Append(ledger.ClinicId, ledger.CallId, ledger.Id, current.Id, current.Role,
                "RecordingDownloaded", "Ok", "proxy");
            var downloadName = $"recording-{ledger.CallId:N}.mp4";
            return Results.File(stream, "video/mp4", downloadName, enableRangeProcessing: true);
        }).RequireAuthorization();


        app.MapDelete("/api/calls/{id:guid}/recording", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            IRecordingStorage storage,
            IRecordingCatalog catalog,
            RecordingAuditService audit,
            CallDispatcher dispatcher,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var denied = RecordingAuthorization.RequireManager(current);
            if (denied is not null) return denied;

            var call = RecordingAuthorization.GetClinicCallForManager(calls, id, current);
            string? key = null;
            string? recId = null;
            var clinicId = current!.ClinicId;

            if (call is not null)
            {
                clinicId = call.ClinicId;
                lock (call.SyncRoot)
                {
                    if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
                        return Results.Conflict(new { error = "Cannot delete an active recording." });
                    key = call.RecordingStorageKey;
                    recId = call.RecordingId;
                    if (call.RecordingStatus == "Deleted" && string.IsNullOrWhiteSpace(key))
                        return Results.Ok(new { status = "Deleted" });
                }
            }

            // Catalog survives API restart even when CallSession is gone.
            var latest = await catalog.GetLatestByCallAsync(id, cancellationToken);
            if (latest is not null)
            {
                if (!string.Equals(latest.ClinicId, current.ClinicId, StringComparison.OrdinalIgnoreCase))
                    return Results.NotFound();
                if (RecordingLedgerStatus.IsActive(latest.Status))
                    return Results.Conflict(new { error = "Cannot delete an active recording." });
                recId ??= latest.Id;
                key ??= latest.StorageKey;
                clinicId = latest.ClinicId;
                if (latest.Status == RecordingLedgerStatus.Deleted && string.IsNullOrWhiteSpace(key))
                    return Results.Ok(new { status = "Deleted" });
            }
            else if (call is null)
            {
                return Results.NotFound();
            }

            if (!string.IsNullOrWhiteSpace(key))
            {
                try
                {
                    await storage.DeleteAsync(key, cancellationToken);
                }
                catch (Exception ex)
                {
                    audit.Append(clinicId, id, recId, current.Id, current.Role,
                        "RecordingDeleted", "Failed", ex.Message);
                    return Results.Json(new { error = ex.Message }, statusCode: 503);
                }
            }

            if (call is not null)
            {
                lock (call.SyncRoot)
                {
                    call.RecordingStatus = "Deleted";
                    call.RecordingStorageKey = null;
                    call.RecordingFileName = null;
                    call.RecordingEgressId = null;
                    call.UpdatedAt = DateTimeOffset.UtcNow;
                }
                await dispatcher.NotifyCallAsync(call);
            }

            if (!string.IsNullOrWhiteSpace(recId))
            {
                try { await catalog.MarkDeletedAsync(recId, cancellationToken); }
                catch { /* best-effort */ }
            }
            audit.Append(clinicId, id, recId, current.Id, current.Role,
                "RecordingDeleted", "Ok");
            return Results.Ok(new { status = "Deleted" });
        }).RequireAuthorization();

        // Embed visitor consent (session ownership)

        return app;
    }
}
