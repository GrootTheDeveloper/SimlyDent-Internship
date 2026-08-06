using System.Collections.Concurrent;
using System.Security.Claims;

namespace LiveKitPoc.Api;

/// <summary>
/// Small clinic-scoped authorization helpers for the in-memory PoC.
/// ClinicId always comes from the authenticated principal / server identity registry —
/// never from client body, query, or headers.
/// </summary>
public static class ClinicAuthorization
{
    /// <summary>
    /// Convention: missing or foreign clinic resources return 404 (not 403) to reduce
    /// call-id enumeration across clinics. Role/participant mismatches that are clearly
    /// same-clinic wrong-actor cases may still return 403.
    /// </summary>
    public static TestIdentity? CurrentUser(ClaimsPrincipal? principal, IdentityRegistry identities)
    {
        if (principal?.Identity?.IsAuthenticated != true) return null;
        var id = principal.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? principal.FindFirstValue("sub");
        var user = identities.Find(id);
        if (user is null) return null;

        // Prefer registry (server truth). If JWT clinic_id disagrees, still use registry.
        // Do not trust a client-supplied clinic claim without registry match.
        return user;
    }

    public static string? CurrentClinicId(ClaimsPrincipal? principal, IdentityRegistry identities) =>
        CurrentUser(principal, identities)?.ClinicId;

    /// <summary>
    /// Lookup call by id and require same clinic. Returns null when missing or cross-clinic.
    /// </summary>
    public static CallSession? TryGetClinicCall(
        ConcurrentDictionary<Guid, CallSession> calls,
        Guid callId,
        TestIdentity actor)
    {
        if (!calls.TryGetValue(callId, out var call)) return null;
        if (!call.BelongsToClinic(actor.ClinicId)) return null;
        return call;
    }

    /// <summary>
    /// Call must exist in actor's clinic and actor must be a participant.
    /// Cross-clinic or non-participant → null (caller maps to 404).
    /// </summary>
    public static CallSession? GetAuthorizedCall(
        ConcurrentDictionary<Guid, CallSession> calls,
        Guid callId,
        TestIdentity actor)
    {
        var call = TryGetClinicCall(calls, callId, actor);
        if (call is null) return null;
        if (!call.Contains(actor.Id)) return null;
        return call;
    }

    /// <summary>
    /// Same as GetAuthorizedCall but requires a specific role (caller or callee).
    /// </summary>
    public static CallSession? GetAuthorizedCallAs(
        ConcurrentDictionary<Guid, CallSession> calls,
        Guid callId,
        TestIdentity actor,
        bool requireCaller = false,
        bool requireCallee = false)
    {
        var call = GetAuthorizedCall(calls, callId, actor);
        if (call is null) return null;
        if (requireCaller && call.CallerId != actor.Id) return null;
        if (requireCallee && call.CalleeId != actor.Id) return null;
        return call;
    }

    public static bool SameClinic(TestIdentity a, TestIdentity b) =>
        string.Equals(a.ClinicId, b.ClinicId, StringComparison.OrdinalIgnoreCase);

    public static bool IsStaff(TestIdentity? user) =>
        user is not null
        && string.Equals(user.Role, IdentityRoles.Staff, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Clinic overview endpoints (queue/agents/presence/directory) are staff-only.
    /// Returns null when OK; otherwise an IResult to return immediately.
    /// </summary>
    public static IResult? RequireStaff(TestIdentity? user)
    {
        if (user is null) return Results.Unauthorized();
        if (!IsStaff(user))
            return Results.Json(new { error = "Staff role required." }, statusCode: 403);
        return null;
    }
}
