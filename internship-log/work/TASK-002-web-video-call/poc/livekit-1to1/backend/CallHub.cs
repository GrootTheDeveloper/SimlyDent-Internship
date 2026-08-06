using System.Collections.Concurrent;
using System.Security.Claims;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

/// <summary>
/// SignalR hub for call invitations, agent presence, and queue overview.
/// Group membership is derived solely from JWT → IdentityRegistry (server-owned ClinicId).
/// </summary>
[Authorize]
public sealed class CallHub(
    IdentityRegistry identities,
    AgentRegistry agents,
    CallDispatcher dispatcher,
    ConcurrentDictionary<Guid, CallSession> calls,
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
        Context.Items["role"] = identity.Role;

        await Groups.AddToGroupAsync(Context.ConnectionId, UserGroup(identity.ClinicId, identity.Id));
        await Groups.AddToGroupAsync(Context.ConnectionId, ClinicGroup(identity.ClinicId));

        if (identity.Role == IdentityRoles.Staff)
        {
            // Resume InCall if staff still on an Accepted call (refresh mid-call).
            Guid? activeInCall = null;
            foreach (var call in calls.Values)
            {
                if (!call.BelongsToClinic(identity.ClinicId) || !call.Contains(identity.Id)) continue;
                if (call.Status == CallStatus.Accepted)
                {
                    activeInCall = call.Id;
                    break;
                }
            }

            agents.Connect(identity.ClinicId, identity.Id, activeInCall);
            await dispatcher.BroadcastAgentsAsync(identity.ClinicId);
            if (activeInCall is null)
                await dispatcher.TryDispatchClinicAsync(identity.ClinicId);
        }
        else
        {
            // Clients.Caller is on Hub (this), not IHubContext.
            await Clients.Caller.SendAsync(
                PresenceEvent,
                agents.SnapshotForClinic(identities, identity.ClinicId));
        }

        await Clients.Caller.SendAsync("QueueUpdated", dispatcher.QueueSnapshot(identity.ClinicId));
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.TryGetValue("userId", out var uidObj) && uidObj is string userId
            && Context.Items.TryGetValue("clinicId", out var cidObj) && cidObj is string clinicId
            && Context.Items.TryGetValue("role", out var roleObj) && roleObj is string role
            && role == IdentityRoles.Staff)
        {
            var (_, releasedCallId, wasRinging) = agents.Disconnect(clinicId, userId);
            if (releasedCallId is Guid callId && wasRinging && calls.TryGetValue(callId, out var call))
            {
                await dispatcher.OnRingingReleasedAsync(call, CallStatus.Cancelled);
            }
            else
            {
                await dispatcher.BroadcastAgentsAsync(clinicId);
                await dispatcher.TryDispatchClinicAsync(clinicId);
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    /// <summary>Staff client heartbeat (also refreshes lease freshness).</summary>
    public Task Heartbeat()
    {
        if (Context.Items.TryGetValue("userId", out var uidObj) && uidObj is string userId
            && Context.Items.TryGetValue("clinicId", out var cidObj) && cidObj is string clinicId
            && Context.Items.TryGetValue("role", out var roleObj) && roleObj is string role
            && role == IdentityRoles.Staff)
        {
            agents.Heartbeat(clinicId, userId);
        }
        return Task.CompletedTask;
    }

    public static string ClinicGroup(string clinicId) =>
        $"clinic:{clinicId.Trim().ToLowerInvariant()}";

    public static string UserGroup(string clinicId, string userId) =>
        $"clinic:{clinicId.Trim().ToLowerInvariant()}:user:{userId.Trim().ToUpperInvariant()}";

    public static string Group(string clinicId, string userId) => UserGroup(clinicId, userId);
}
