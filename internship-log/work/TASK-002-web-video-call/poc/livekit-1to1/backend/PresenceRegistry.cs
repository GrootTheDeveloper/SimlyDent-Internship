using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Tracks SignalR connection counts per user for simple online presence (PoC).
/// </summary>
public sealed class PresenceRegistry
{
    private readonly ConcurrentDictionary<string, int> _connections =
        new(StringComparer.OrdinalIgnoreCase);

    public bool IsOnline(string userId) =>
        _connections.TryGetValue(userId, out var count) && count > 0;

    public IReadOnlyCollection<string> OnlineUserIds =>
        _connections.Where(kv => kv.Value > 0).Select(kv => kv.Key).ToArray();

    public int Connect(string userId) =>
        _connections.AddOrUpdate(userId, 1, static (_, n) => n + 1);

    public int Disconnect(string userId)
    {
        var next = _connections.AddOrUpdate(userId, 0, static (_, n) => Math.Max(0, n - 1));
        if (next == 0)
            _connections.TryRemove(userId, out _);
        return next;
    }

    public PresenceSnapshot SnapshotForTenant(IdentityRegistry identities, string tenantId)
    {
        var members = identities.All
            .Where(i => string.Equals(i.TenantId, tenantId, StringComparison.OrdinalIgnoreCase))
            .Select(i => new PresenceUser(i.Id, IsOnline(i.Id)))
            .ToArray();
        return new PresenceSnapshot(tenantId, members);
    }
}

public sealed record PresenceUser(string UserId, bool Online);

public sealed record PresenceSnapshot(string TenantId, IReadOnlyList<PresenceUser> Users);
