using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public sealed class CallHub(IdentityRegistry identities) : Hub
{
    public override async Task OnConnectedAsync()
    {
        var userId = Context.GetHttpContext()?.Request.Query["userId"].ToString();
        var identity = identities.Find(userId);
        if (identity is null)
        {
            Context.Abort();
            return;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, Group(identity.Id));
        await base.OnConnectedAsync();
    }

    public static string Group(string userId) => $"user:{userId.ToUpperInvariant()}";
}

