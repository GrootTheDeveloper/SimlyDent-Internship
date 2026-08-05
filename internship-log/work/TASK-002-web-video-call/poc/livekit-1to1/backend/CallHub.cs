using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public sealed class CallHub(
    IdentityRegistry identities,
    PresenceRegistry presence,
    IHubContext<CallHub> hubContext) : Hub
{
    public const string PresenceEvent = "PresenceUpdated";

    public override async Task OnConnectedAsync()
    {
        var userId = Context.GetHttpContext()?.Request.Query["userId"].ToString();
        var identity = identities.Find(userId);
        if (identity is null)
        {
            Context.Abort();
            return;
        }

        Context.Items["userId"] = identity.Id;
        Context.Items["tenantId"] = identity.TenantId;

        await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(identity.Id));
        await Groups.AddToGroupAsync(Context.ConnectionId, TenantGroup(identity.TenantId));

        presence.Connect(identity.Id);
        await BroadcastPresenceAsync(identity.TenantId);
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("userId", out var uidObj) && uidObj is string userId
            && Context.Items.TryGetValue("tenantId", out var tidObj) && tidObj is string tenantId)
        {
            presence.Disconnect(userId);
            await BroadcastPresenceAsync(tenantId);
        }

        await base.OnDisconnectedAsync(exception);
    }

    private Task BroadcastPresenceAsync(string tenantId)
    {
        var snapshot = presence.SnapshotForTenant(identities, tenantId);
        return hubContext.Clients.Group(TenantGroup(tenantId))
            .SendAsync(PresenceEvent, snapshot);
    }

    public static string UserGroup(string userId) => $"user:{userId.ToUpperInvariant()}";

    public static string TenantGroup(string tenantId) => $"tenant:{tenantId.ToUpperInvariant()}";

    /// <summary>Legacy alias used by Program.cs notify helpers.</summary>
    public static string Group(string userId) => UserGroup(userId);
}
