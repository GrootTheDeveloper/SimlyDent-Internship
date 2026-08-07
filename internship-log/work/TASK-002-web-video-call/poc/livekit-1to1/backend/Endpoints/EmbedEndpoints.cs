using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public static class EmbedEndpoints
{
    public static IEndpointRouteBuilder MapEmbedEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/embed/session", (
            HttpContext http,
            EmbedSessionRequest body,
            ClinicSiteRegistry sites,
            EmbedAuthTokenService embedAuth,
            EmbedRateLimiter rateLimiter) =>
        {
            var origin = http.Request.Headers.Origin.FirstOrDefault()
                         ?? http.Request.Headers["Origin"].FirstOrDefault();

            if (string.IsNullOrWhiteSpace(body.SiteKey))
                return Results.BadRequest(new { error = "siteKey is required." });

            var site = sites.FindBySiteKey(body.SiteKey);
            if (site is null)
                return Results.NotFound(new { error = "Unknown site key." });
            if (!site.Enabled)
                return Results.Json(new { error = "Site is disabled." }, statusCode: 403);

            // Exact Origin allowlist for THIS site_key (not union-only).
            if (!OriginMatcher.IsAllowed(origin, site.AllowedOrigins))
                return Results.Json(new { error = "Origin is not allowed for this site key." }, statusCode: 403);

            var clientIp = EmbedRateLimiter.GetClientIp(http);
            var rateKey = $"session:{site.SiteKey}:{clientIp}";
            if (!rateLimiter.TryAcquire(rateKey))
                return Results.Json(new { error = "Rate limit exceeded." }, statusCode: 429);

            var (token, expiresAt, sessionId) = embedAuth.CreateSessionToken(site);
            return Results.Ok(new EmbedSessionResponse(
                token,
                expiresAt,
                sessionId,
                site.ClinicId,
                site.SiteId,
                site.SiteKey));
        }).RequireCors("EmbedCors");

        // ---- Embed calls (visitor session) — Phase 2 PR-B ----
        // Auth: EmbedBearer only. Ownership: session VisitorId == call.CallerId + same clinic.
        // DTO: EmbedCallView (no room/recording/staff internals). Media token only after Accept.


        app.MapPost("/embed/calls", async (
            HttpContext http,
            ClaimsPrincipal principal,
            CallDispatcher dispatcher,
            EmbedRateLimiter rateLimiter,
            CreateQueueCallRequest? body) =>
        {
            var session = EmbedAuthTokenService.TryReadSession(principal);
            if (session is null) return Results.Unauthorized();

            var clientIp = EmbedRateLimiter.GetClientIp(http);
            var rateKey = $"calls:{session.SessionId}:{clientIp}";
            if (!rateLimiter.TryAcquire(rateKey))
                return Results.Json(new { error = "Rate limit exceeded." }, statusCode: 429);

            // Authoritative join preference for BOTH visitor and staff (Audio | Video).
            // Widget sends { initialMediaMode: "Audio"|"Video" }; previously ignored → always Video.
            var mediaMode = CallSession.NormalizeMediaMode(body?.InitialMediaMode);
            var actor = CallActor.FromEmbed(session);
            var call = await dispatcher.EnqueueAsync(actor.AsIdentity(), mediaMode);
            ClinicAuthorization.TouchVisitorSeen(call);

            if (call.Status == CallStatus.Closed)
                return Results.Json(
                    new { error = "Clinic is closed.", call = EmbedCallView.From(call) },
                    statusCode: 403);

            return Results.Created($"/embed/calls/{call.Id}", EmbedCallView.From(call));
        }).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");


        app.MapGet("/embed/calls/{id:guid}", (
            Guid id,
            ClaimsPrincipal principal,
            ConcurrentDictionary<Guid, CallSession> calls) =>
        {
            var session = EmbedAuthTokenService.TryReadSession(principal);
            if (session is null) return Results.Unauthorized();

            var call = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
            if (call is null) return Results.NotFound();

            // Poll = visitor heartbeat for stale recovery.
            ClinicAuthorization.TouchVisitorSeen(call);
            return Results.Ok(EmbedCallView.From(call));
        }).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");


        app.MapPost("/embed/calls/{id:guid}/cancel", async (
            Guid id,
            ClaimsPrincipal principal,
            ConcurrentDictionary<Guid, CallSession> calls,
            CallDispatcher dispatcher) =>
        {
            var session = EmbedAuthTokenService.TryReadSession(principal);
            if (session is null) return Results.Unauthorized();

            // Ownership gate first → 404 for cross-session / cross-clinic (no enumeration).
            var owned = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
            if (owned is null) return Results.NotFound();

            ClinicAuthorization.TouchVisitorSeen(owned);
            var result = await dispatcher.TryCancelAsync(id, CallActor.FromEmbed(session).AsIdentity());
            return result.Kind switch
            {
                CallTransitionKind.Ok => Results.Ok(EmbedCallView.From(result.Call!)),
                CallTransitionKind.NotFound => Results.NotFound(),
                CallTransitionKind.Forbidden => Results.StatusCode(403),
                _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
            };
        }).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");


        app.MapPost("/embed/calls/{id:guid}/end", async (
            Guid id,
            ClaimsPrincipal principal,
            ConcurrentDictionary<Guid, CallSession> calls,
            CallEndService endService,
            CancellationToken cancellationToken) =>
        {
            var session = EmbedAuthTokenService.TryReadSession(principal);
            if (session is null) return Results.Unauthorized();

            var owned = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
            if (owned is null) return Results.NotFound();

            ClinicAuthorization.TouchVisitorSeen(owned);
            var result = await endService.EndWithRecordingAsync(
                id, CallActor.FromEmbed(session).AsIdentity(), cancellationToken);
            return result.Kind switch
            {
                CallTransitionKind.Ok => Results.Ok(EmbedCallView.From(result.Call!)),
                CallTransitionKind.NotFound => Results.NotFound(),
                CallTransitionKind.Forbidden => Results.StatusCode(403),
                _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
            };
        }).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");


        app.MapPost("/embed/calls/{id:guid}/token", (
            Guid id,
            HttpRequest request,
            ClaimsPrincipal principal,
            ConcurrentDictionary<Guid, CallSession> calls,
            LiveKitTokenService tokens) =>
        {
            var session = EmbedAuthTokenService.TryReadSession(principal);
            if (session is null) return Results.Unauthorized();

            var call = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
            if (call is null) return Results.NotFound();

            ClinicAuthorization.TouchVisitorSeen(call);

            string roomName;
            lock (call.SyncRoot)
            {
                if (call.Status != CallStatus.Accepted)
                    return Results.Conflict(new { error = "Media token is available only after accept." });
                roomName = call.RoomName;
            }

            // Room is server-chosen; widget never selects room. LiveKit JWT embeds room claim.
            var mediaTtlMinutes = int.TryParse(
                Environment.GetEnvironmentVariable("LIVEKIT_JOIN_TOKEN_MINUTES"), out var ttl)
                ? Math.Clamp(ttl, 5, 180)
                : 60;
            var identity = CallActor.FromEmbed(session).AsIdentity();
            var (token, expiresAt) = tokens.CreateJoinToken(identity, roomName, TimeSpan.FromMinutes(mediaTtlMinutes));
            return Results.Ok(new TokenResponse(LiveKitUrl.WebSocketUrl(request), token, expiresAt));
        }).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

        // ---- Auth ----


        app.MapPost("/embed/calls/{id:guid}/recording/consent", (
            Guid id,
            SetConsentRequest body,
            ClaimsPrincipal principal,
            ConcurrentDictionary<Guid, CallSession> calls,
            RecordingPolicyRegistry policies,
            RecordingAuditService audit) =>
        {
            var session = EmbedAuthTokenService.TryReadSession(principal);
            if (session is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
            if (call is null) return Results.NotFound();
            if (!Enum.TryParse<ConsentStatus>(body.Status, ignoreCase: true, out var consent)
                || consent == ConsentStatus.Pending)
                return Results.BadRequest(new { error = "Status must be Granted or Declined." });
            var policy = policies.Get(call.ClinicId);
            lock (call.SyncRoot)
            {
                call.ConsentStatus = consent;
                call.ConsentActorId = session.VisitorId;
                call.ConsentPolicyVersion = policy.Version;
                call.ConsentGrantedAt = consent == ConsentStatus.Granted ? DateTimeOffset.UtcNow : null;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
            audit.Append(call.ClinicId, call.Id, call.RecordingId, session.VisitorId, IdentityRoles.Visitor,
                consent == ConsentStatus.Granted ? "ConsentGranted" : "ConsentDeclined", "Ok");
            return Results.Ok(EmbedCallView.From(call));
        }).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

        return app;
    }
}
