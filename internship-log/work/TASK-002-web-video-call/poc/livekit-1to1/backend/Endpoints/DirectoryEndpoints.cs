using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public static class DirectoryEndpoints
{
    public static IEndpointRouteBuilder MapDirectoryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/identities", (ClaimsPrincipal principal, IdentityRegistry registry) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, registry);
            var denied = ClinicAuthorization.RequireStaffOrManager(current);
            if (denied is not null) return denied;
            var peers = registry.DirectoryForClinic(current!.ClinicId, includeLoadUsers: false)
                .Select(ApiAuthMapping.ToUserDto);
            return Results.Ok(peers);
        }).RequireAuthorization();


        app.MapGet("/api/presence", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            AgentRegistry agents) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = ClinicAuthorization.RequireStaffOrManager(current);
            if (denied is not null) return denied;
            return Results.Ok(agents.SnapshotForClinic(identities, current!.ClinicId));
        }).RequireAuthorization();


        app.MapGet("/api/clinics/me/recording-policy", (
            ClaimsPrincipal principal,
            IdentityRegistry identities,
            RecordingPolicyRegistry policies) =>
        {
            var current = ClinicAuthorization.CurrentUser(principal, identities);
            var denied = ClinicAuthorization.RequireStaffOrManager(current);
            if (denied is not null) return denied;
            return Results.Ok(policies.Get(current!.ClinicId).ToView());
        }).RequireAuthorization();

        /// <summary>
        /// Manager library: clinic-scoped recordings from durable catalog (fallback: in-memory calls).
        /// Staff → 403. Cross-clinic isolation by principal clinic only.
        /// </summary>

        return app;
    }
}
