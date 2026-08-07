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

public static class CallEndpoints
{
    public static IEndpointRouteBuilder MapCallEndpoints(this IEndpointRouteBuilder app)
    {
        var endpointLogger = LoggerFactory.Create(b => b.AddConsole()).CreateLogger("Endpoints");
        app.MapPost("/api/calls", async (
            ClaimsPrincipal principal,
            CreateCallRequest body,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            CallDispatcher dispatcher,
            AgentRegistry agents,
            RecordingPolicyRegistry recordingPolicies) =>
        {
            var caller = ClinicAuthorization.CurrentUser(principal, identities);
            if (caller is null) return Results.Unauthorized();
            if (caller.Role == IdentityRoles.Visitor)
                return Results.Json(new { error = "Visitors must use POST /api/queue/calls." }, statusCode: 403);
            // Managers may observe; only Staff place direct calls (or Staff callee).
            if (caller.Role == IdentityRoles.Manager)
                return Results.Json(new { error = "Managers do not place direct media calls in this PoC." }, statusCode: 403);

            var callee = identities.Find(body.CalleeId);
            if (callee is null) return Results.BadRequest(new { error = "Unknown callee." });
            if (callee.Role != IdentityRoles.Staff)
                return Results.BadRequest(new { error = "Direct calls require a staff callee." });
            if (caller.Id == callee.Id) return Results.BadRequest(new { error = "Self-call is not allowed." });
            if (!ClinicAuthorization.SameClinic(caller, callee))
                return Results.Json(new { error = "Không thể gọi user phòng khám / clinic khác." }, statusCode: 403);

            var now = DateTimeOffset.UtcNow;
            var busy = calls.Values.Any(call =>
            {
                if (!call.IsActive) return false;
                if (call.Status == CallStatus.Ringing && call.Origin == CallOrigin.Direct
                    && now - call.UpdatedAt > TimeSpan.FromSeconds(45))
                {
                    lock (call.SyncRoot)
                    {
                        if (call.Status == CallStatus.Ringing)
                        {
                            call.Status = CallStatus.Ended;
                            call.UpdatedAt = now;
                        }
                    }
                    agents.TryRelease(call.ClinicId, call.CalleeId, call.Id, force: true);
                    agents.TryRelease(call.ClinicId, call.CallerId, call.Id, force: true);
                    return false;
                }
                return call.Contains(caller.Id) || call.Contains(callee.Id);
            });
            if (busy) return Results.Conflict(new { error = "Caller or callee is busy." });

            if (agents.IsBusy(callee.ClinicId, callee.Id))
                return Results.Conflict(new { error = "Callee is busy." });

            var id = Guid.NewGuid();
            var policy = recordingPolicies.Get(caller.ClinicId);
            var mediaMode = CallSession.NormalizeMediaMode(body.InitialMediaMode);
            var session = new CallSession
            {
                Id = id,
                ClinicId = caller.ClinicId,
                CallerId = caller.Id,
                CalleeId = callee.Id,
                Origin = CallOrigin.Direct,
                RoomName = CallSession.BuildRoomName(caller.ClinicId, id),
                RecordingMode = policy.DefaultMode,
                InitialMediaMode = mediaMode
            };
            if (!dispatcher.TryAssignDirect(session, callee.Id))
                return Results.Conflict(new { error = "Callee is not available (busy)." });

            calls[id] = session;
            await dispatcher.NotifyCallAsync(session);
            await dispatcher.BroadcastAgentsAsync(session.ClinicId);
            return Results.Created($"/api/calls/{id}", session.ToView());
        }).RequireAuthorization();


        app.MapGet("/api/calls/active", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var active = calls.Values
                .Where(call => call.BelongsToClinic(current.ClinicId) && call.Contains(current.Id) && call.IsActive)
                .OrderByDescending(call => call.CreatedAt)
                .FirstOrDefault();
            return active is null ? Results.NoContent() : Results.Ok(active.ToView());
        }).RequireAuthorization();


        app.MapGet("/api/calls/{id:guid}", (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
            return call is null ? Results.NotFound() : Results.Ok(call.ToView());
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/accept", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            CallDispatcher dispatcher,
            IConsultationCatalog consultationCatalog,
            ConsultationAudioService audioService,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsStaff(current))
                return Results.StatusCode(403);

            var result = await dispatcher.TryAcceptAsync(id, current);
            if (result.Kind == CallTransitionKind.Ok && result.Call is not null)
            {
                var call = result.Call;
                try
                {
                    var caller = identities.Find(call.CallerId);
                    var staff = identities.Find(call.AssignedStaffId ?? call.CalleeId ?? current.Id);
                    var session = await consultationCatalog.EnsureSessionAsync(
                        call.Id, call.ClinicId, call.RoomName,
                        call.CallerId, caller?.DisplayName ?? call.CallerId,
                        staff?.Id ?? current.Id, staff?.DisplayName ?? current.DisplayName,
                        initialMediaMode: CallSession.NormalizeMediaMode(call.InitialMediaMode),
                        cancellationToken);
                    lock (call.SyncRoot) { call.ConsultationSessionId = session.Id; }
                    // Best-effort auto audio (consent gate inside)
                    await audioService.EnsureAutoAudioStartedAsync(call, cancellationToken);
                }
                catch (Exception ex)
                {
                    // Never fail Accept — media is independent of call
                    endpointLogger.LogWarning(ex, "Consultation session/audio ensure failed on Accept {CallId}", call.Id);
                }
            }
            return result.Kind switch
            {
                CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
                CallTransitionKind.NotFound => Results.NotFound(),
                CallTransitionKind.Forbidden => Results.StatusCode(403),
                _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
            };
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/reject", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            CallDispatcher dispatcher) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            if (!ClinicAuthorization.IsStaff(current))
                return Results.StatusCode(403);

            var result = await dispatcher.TryRejectAsync(id, current);
            return result.Kind switch
            {
                CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
                CallTransitionKind.NotFound => Results.NotFound(),
                CallTransitionKind.Forbidden => Results.StatusCode(403),
                _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
            };
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/cancel", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            CallDispatcher dispatcher) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();

            var result = await dispatcher.TryCancelAsync(id, current);
            return result.Kind switch
            {
                CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
                CallTransitionKind.NotFound => Results.NotFound(),
                CallTransitionKind.Forbidden => Results.StatusCode(403),
                _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
            };
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/end", async (
            Guid id,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            CallEndService endService,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();

            var result = await endService.EndWithRecordingAsync(id, current, cancellationToken);
            return result.Kind switch
            {
                CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
                CallTransitionKind.NotFound => Results.NotFound(),
                CallTransitionKind.Forbidden => Results.StatusCode(403),
                _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
            };
        }).RequireAuthorization();


        app.MapPost("/api/calls/{id:guid}/token", async (
            Guid id,
            HttpRequest request,
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            ConcurrentDictionary<Guid, CallSession> calls,
            LiveKitTokenService tokens,
            ConsultationAudioService audioService,
            CancellationToken cancellationToken) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            if (current is null) return Results.Unauthorized();
            var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
            if (call is null) return Results.NotFound();
            lock (call.SyncRoot)
            {
                if (call.Status != CallStatus.Accepted)
                    return Results.Conflict(new { error = "Media token is available only after accept." });
            }
            // Second chance for auto CallAudio (Accept may run before anyone is in the room).
            try
            {
                await audioService.EnsureAutoAudioStartedAsync(call, cancellationToken);
            }
            catch (Exception ex)
            {
                endpointLogger.LogWarning(ex, "Auto audio ensure on token failed for {CallId}", id);
            }
            var mediaTtlMinutes = int.TryParse(
                Environment.GetEnvironmentVariable("LIVEKIT_JOIN_TOKEN_MINUTES"), out var ttl)
                ? Math.Clamp(ttl, 5, 180)
                : 60;
            var (token, expiresAt) = tokens.CreateJoinToken(current, call.RoomName, TimeSpan.FromMinutes(mediaTtlMinutes));
            return Results.Ok(new TokenResponse(LiveKitUrl.WebSocketUrl(request), token, expiresAt));
        }).RequireAuthorization();

        // ---- Recording control (Phase 3) — RecordingAuthorization ≠ call participant alone ----

        return app;
    }
}
