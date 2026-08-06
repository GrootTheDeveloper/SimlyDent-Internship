using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

/// <summary>
/// SignalR hub for call invitations and presence.
/// Group membership is derived solely from JWT → IdentityRegistry (server-owned ClinicId).
/// There is no JoinClinic(clinicId) client method — browsers cannot switch clinics.
/// </summary>
[Authorize]
public sealed class CallHub(
    IdentityRegistry identities,
    PresenceRegistry presence,
    IHubContext<CallHub> hubContext) : Hub
{
    public const string PresenceEvent = "PresenceUpdated";

    public override async Task OnConnectedAsync()
    {
        var userId = Context.User?.FindFirstValue(ClaimTypes.NameIdentifier)
            ?? Context.User?.FindFirstValue("sub");
        var identity = identities.Find(userId);
        if (identity is null)
        {
            Context.Abort();
            return;
        }

        Context.Items["userId"] = identity.Id;
        Context.Items["clinicId"] = identity.ClinicId;

        // Personal group is namespaced by clinic so user ids cannot collide across clinics.
        await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(identity.ClinicId, identity.Id));
        await Groups.AddToGroupAsync(Context.ConnectionId, ClinicGroup(identity.ClinicId));

        presence.Connect(identity.ClinicId, identity.Id);
        await BroadcastPresenceAsync(identity.ClinicId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("userId", out var uidObj) && uidObj is string userId
            && Context.Items.TryGetValue("clinicId", out var cidObj) && cidObj is string clinicId)
        {
            presence.Disconnect(clinicId, userId);
            await BroadcastPresenceAsync(clinicId);
        }

        await base.OnDisconnectedAsync(exception);
    }

    private Task BroadcastPresenceAsync(string clinicId)
    {
        var snapshot = presence.SnapshotForClinic(identities, clinicId);
        // Only members of this clinic group receive presence — never cross-clinic.
        return hubContext.Clients.Group(ClinicGroup(clinicId))
            .SendAsync(PresenceEvent, snapshot);
    }

    /// <summary>clinic:{clinicId}</summary>
    public static string ClinicGroup(string clinicId) =>
        $"clinic:{clinicId.Trim().ToLowerInvariant()}";

    /// <summary>clinic:{clinicId}:user:{userId}</summary>
    public static string UserGroup(string clinicId, string userId) =>
        $"clinic:{clinicId.Trim().ToLowerInvariant()}:user:{userId.Trim().ToUpperInvariant()}";

    /// <summary>Notify a specific user inside a clinic (call invites / state).</summary>
    public static string Group(string clinicId, string userId) => UserGroup(clinicId, userId);
}
