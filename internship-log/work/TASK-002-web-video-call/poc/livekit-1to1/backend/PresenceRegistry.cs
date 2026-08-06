using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Tracks SignalR connection counts for simple online presence (PoC).
/// Keys are clinic-scoped: "{clinicId}|{userId}" to avoid cross-clinic collisions
/// even if user ids were reused across clinics in the future.
/// </summary>
public sealed class PresenceRegistry
{
    private readonly ConcurrentDictionary<string, int> _connections =
        new(StringComparer.OrdinalIgnoreCase);

    public static string Key(string clinicId, string userId) =>
        $"{clinicId.Trim()}|{userId.Trim()}";

    public bool IsOnline(string clinicId, string userId) =>
        _connections.TryGetValue(Key(clinicId, userId), out var count) && count > 0;

    public int Connect(string clinicId, string userId) =>
        _connections.AddOrUpdate(Key(clinicId, userId), 1, static (_, n) => n + 1);

    public int Disconnect(string clinicId, string userId)
    {
        var key = Key(clinicId, userId);
        var next = _connections.AddOrUpdate(key, 0, static (_, n) => Math.Max(0, n - 1));
        if (next == 0)
            _connections.TryRemove(key, out _);
        return next;
    }

    /// <summary>
    /// Presence is always filtered by the authenticated user's clinic.
    /// Never accept a clinic id from a query string for this snapshot.
    /// </summary>
    public PresenceSnapshot SnapshotForClinic(IdentityRegistry identities, string clinicId)
    {
        var members = identities.All
            .Where(i => string.Equals(i.ClinicId, clinicId, StringComparison.OrdinalIgnoreCase))
            .Select(i => new PresenceUser(i.Id, IsOnline(clinicId, i.Id)))
            .ToArray();
        return new PresenceSnapshot(clinicId, members);
    }
}

public sealed record PresenceUser(string UserId, bool Online);

/// <summary>ClinicId is canonical; TenantId is a compatibility alias.</summary>
public sealed record PresenceSnapshot(string ClinicId, IReadOnlyList<PresenceUser> Users)
{
    public string TenantId => ClinicId;
}
