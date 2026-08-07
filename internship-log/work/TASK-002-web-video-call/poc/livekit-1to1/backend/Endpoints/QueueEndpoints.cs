using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public static class QueueEndpoints
{
    public static IEndpointRouteBuilder MapQueueEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/agents", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            AgentRegistry agents) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = ClinicAuthorization.RequireStaffOrManager(current);
            if (denied is not null) return denied;
            return Results.Ok(agents.SnapshotForClinic(identities, current!.ClinicId));
        }).RequireAuthorization();


        app.MapGet("/api/queue", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            CallDispatcher dispatcher) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = ClinicAuthorization.RequireStaffOrManager(current);
            if (denied is not null) return denied;
            return Results.Ok(dispatcher.QueueSnapshot(current!.ClinicId));
        }).RequireAuthorization();

        // ---- Recording policy (Phase 3) ----


        app.MapPost("/api/agents/heartbeat", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            AgentRegistry agents) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = ClinicAuthorization.RequireStaff(current);
            if (denied is not null) return denied;
            return Results.Ok(agents.Heartbeat(current!.ClinicId, current.Id));
        }).RequireAuthorization();

        /// <summary>Staff ready for auto-dispatch (SignalR connect also does this).</summary>


        app.MapPost("/api/agents/ready", async (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            AgentRegistry agents,
            CallDispatcher dispatcher) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = ClinicAuthorization.RequireStaff(current);
            if (denied is not null) return denied;
            var view = agents.MarkReady(current!.ClinicId, current.Id);
            await dispatcher.BroadcastAgentsAsync(current.ClinicId);
            await dispatcher.TryDispatchClinicAsync(current.ClinicId);
            return Results.Ok(view);
        }).RequireAuthorization();

        // ---- Queue path (visitor auto-dispatch) ----


        app.MapPost("/api/queue/calls", async (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            CallDispatcher dispatcher,
            CreateQueueCallRequest? body) =>
        {
            var visitor = ClinicAuthorization.CurrentUser(principal, identities);
            if (visitor is null) return Results.Unauthorized();
            // Phase 1: demo visitors VA/VB. Staff may also enqueue for manual testing.
            var mediaMode = CallSession.NormalizeMediaMode(body?.InitialMediaMode);
            var call = await dispatcher.EnqueueAsync(visitor, mediaMode);
            if (call.Status == CallStatus.Closed)
                return Results.Json(new { error = "Clinic is closed.", call = call.ToView() }, statusCode: 403);
            return Results.Created($"/api/calls/{call.Id}", call.ToView());
        }).RequireAuthorization();

        // ---- Direct staff→staff call (TASK-002 path, still supported) ----

        return app;
    }
}
