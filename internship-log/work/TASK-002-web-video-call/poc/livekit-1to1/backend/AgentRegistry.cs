using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

public enum AgentState
{
    Offline,
    Available,
    Ringing,
    InCall
}

/// <summary>
/// Per-staff lease for TASK-003 Phase 1.
/// State is server-owned; clients only send heartbeats / connect via SignalR.
/// </summary>
public sealed class AgentLease
{
    public required string ClinicId { get; init; }
    public required string UserId { get; init; }
    public AgentState State { get; set; } = AgentState.Offline;
    public int ConnectionCount { get; set; }
    public DateTimeOffset HeartbeatAt { get; set; } = DateTimeOffset.UnixEpoch;
    public Guid? ReservedCallId { get; set; }
    public DateTimeOffset? LastAssignedAt { get; set; }
    public object SyncRoot { get; } = new();

    public AgentView ToView() => new(
        UserId, ClinicId, State.ToString(), ConnectionCount > 0,
        HeartbeatAt, ReservedCallId, LastAssignedAt);
}

/// <summary>
/// Clinic-scoped agent presence + capacity (1 staff ≤ 1 Ringing/InCall).
/// Replaces boolean online-only presence for Phase 1 while keeping snapshot API shape.
/// </summary>
public sealed class AgentRegistry
{
    private readonly ConcurrentDictionary<string, AgentLease> _agents =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly TimeSpan _staleAfter;

    public AgentRegistry(IConfiguration configuration)
    {
        var seconds = int.TryParse(configuration["AGENT_HEARTBEAT_STALE_SECONDS"], out var s) ? s : 45;
        _staleAfter = TimeSpan.FromSeconds(Math.Clamp(seconds, 15, 300));
    }

    public static string Key(string clinicId, string userId) =>
        $"{clinicId.Trim()}|{userId.Trim()}";

    private AgentLease GetOrCreate(string clinicId, string userId)
    {
        return _agents.GetOrAdd(Key(clinicId, userId), _ => new AgentLease
        {
            ClinicId = clinicId,
            UserId = userId
        });
    }

    public AgentLease? Find(string clinicId, string userId) =>
        _agents.TryGetValue(Key(clinicId, userId), out var lease) ? lease : null;

    public bool IsOnline(string clinicId, string userId)
    {
        var lease = Find(clinicId, userId);
        if (lease is null) return false;
        lock (lease.SyncRoot)
            return lease.ConnectionCount > 0 && lease.State != AgentState.Offline;
    }

    /// <summary>
    /// SignalR connect. First connection moves Offline → Available,
    /// unless resuming an Accepted media call (→ InCall with reservedCallId).
    /// </summary>
    public AgentView Connect(string clinicId, string userId, Guid? resumeInCallId = null)
    {
        var lease = GetOrCreate(clinicId, userId);
        lock (lease.SyncRoot)
        {
            lease.ConnectionCount++;
            lease.HeartbeatAt = DateTimeOffset.UtcNow;
            if (resumeInCallId is Guid callId)
            {
                lease.State = AgentState.InCall;
                lease.ReservedCallId = callId;
            }
            else if (lease.State == AgentState.Offline
                     || (lease.ConnectionCount == 1 && lease.State is not (AgentState.Ringing or AgentState.InCall)))
            {
                lease.State = AgentState.Available;
                lease.ReservedCallId = null;
            }
            return lease.ToView();
        }
    }

    /// <summary>
    /// SignalR disconnect — last connection → Offline.
    /// Returns released call id and whether it was Ringing (needs redispatch).
    /// InCall disconnect clears lease but leaves the call Accepted for hangup path.
    /// </summary>
    public (AgentView View, Guid? ReleasedCallId, bool WasRinging) Disconnect(string clinicId, string userId)
    {
        var lease = GetOrCreate(clinicId, userId);
        lock (lease.SyncRoot)
        {
            lease.ConnectionCount = Math.Max(0, lease.ConnectionCount - 1);
            Guid? released = null;
            var wasRinging = false;
            if (lease.ConnectionCount == 0)
            {
                wasRinging = lease.State == AgentState.Ringing;
                released = lease.ReservedCallId;
                lease.State = AgentState.Offline;
                lease.ReservedCallId = null;
            }
            return (lease.ToView(), released, wasRinging);
        }
    }

    public AgentView Heartbeat(string clinicId, string userId)
    {
        var lease = GetOrCreate(clinicId, userId);
        lock (lease.SyncRoot)
        {
            if (lease.ConnectionCount <= 0)
            {
                // Heartbeat without connection does not invent presence.
                return lease.ToView();
            }
            lease.HeartbeatAt = DateTimeOffset.UtcNow;
            if (lease.State == AgentState.Offline)
                lease.State = AgentState.Available;
            return lease.ToView();
        }
    }

    /// <summary>
    /// Staff declares ready for dispatch without SignalR (tests / REST-only clients).
    /// Creates a soft connection count that stale-sweep will clear without heartbeats.
    /// </summary>
    public AgentView MarkReady(string clinicId, string userId)
    {
        var lease = GetOrCreate(clinicId, userId);
        lock (lease.SyncRoot)
        {
            if (lease.ConnectionCount <= 0)
                lease.ConnectionCount = 1;
            lease.HeartbeatAt = DateTimeOffset.UtcNow;
            if (lease.State is AgentState.Offline or AgentState.Available)
            {
                lease.State = AgentState.Available;
                lease.ReservedCallId = null;
            }
            return lease.ToView();
        }
    }

    /// <summary>
    /// Atomically reserve an Available staff for a call → Ringing.
    /// Returns false if offline/busy/wrong state.
    /// </summary>
    public bool TryReserve(string clinicId, string userId, Guid callId)
    {
        var lease = GetOrCreate(clinicId, userId);
        lock (lease.SyncRoot)
        {
            if (lease.ConnectionCount <= 0 || lease.State != AgentState.Available)
                return false;
            lease.State = AgentState.Ringing;
            lease.ReservedCallId = callId;
            lease.LastAssignedAt = DateTimeOffset.UtcNow;
            lease.HeartbeatAt = DateTimeOffset.UtcNow;
            return true;
        }
    }

    /// <summary>
    /// Longest-idle selection: Available staff ordered by LastAssignedAt ASC (nulls first).
    /// Excludes user ids already tried for this call.
    /// </summary>
    public string? TryReserveLongestIdle(
        string clinicId,
        Guid callId,
        IEnumerable<string>? excludeUserIds,
        IdentityRegistry identities)
    {
        var exclude = new HashSet<string>(
            excludeUserIds ?? Array.Empty<string>(),
            StringComparer.OrdinalIgnoreCase);

        // Snapshot candidates under each lease lock, then reserve winner.
        var candidates = identities.DirectoryForClinic(clinicId, includeLoadUsers: false)
            .Where(u => u.Role == IdentityRoles.Staff && !exclude.Contains(u.Id))
            .Select(u => GetOrCreate(clinicId, u.Id))
            .ToList();

        // Sort by longest-idle outside locks using last known LastAssignedAt.
        var ordered = candidates
            .OrderBy(l =>
            {
                lock (l.SyncRoot)
                    return l.LastAssignedAt ?? DateTimeOffset.MinValue;
            })
            .ThenBy(l => l.UserId, StringComparer.OrdinalIgnoreCase)
            .ToList();

        foreach (var lease in ordered)
        {
            if (TryReserve(clinicId, lease.UserId, callId))
                return lease.UserId;
        }
        return null;
    }

    public bool TryMarkInCall(string clinicId, string userId, Guid callId, bool force = false)
    {
        var lease = GetOrCreate(clinicId, userId);
        lock (lease.SyncRoot)
        {
            if (!force)
            {
                if (lease.State != AgentState.Ringing || lease.ReservedCallId != callId)
                    return false;
            }
            else if (lease.State is AgentState.Ringing or AgentState.InCall
                     && lease.ReservedCallId is Guid other && other != callId)
            {
                return false;
            }

            lease.State = AgentState.InCall;
            lease.ReservedCallId = callId;
            lease.HeartbeatAt = DateTimeOffset.UtcNow;
            return true;
        }
    }

    /// <summary>True when staff is Ringing or InCall on any call (capacity full).</summary>
    public bool IsBusy(string clinicId, string userId)
    {
        var lease = Find(clinicId, userId);
        if (lease is null) return false;
        lock (lease.SyncRoot)
            return lease.State is AgentState.Ringing or AgentState.InCall;
    }

    /// <summary>
    /// Release reservation → Available if still connected, else Offline.
    /// Only releases if reservedCallId matches (or force).
    /// </summary>
    public bool TryRelease(string clinicId, string userId, Guid? expectedCallId = null, bool force = false)
    {
        var lease = Find(clinicId, userId);
        if (lease is null) return false;
        lock (lease.SyncRoot)
        {
            if (!force && expectedCallId is not null && lease.ReservedCallId != expectedCallId)
                return false;
            if (lease.State is not (AgentState.Ringing or AgentState.InCall) && !force)
                return false;

            lease.ReservedCallId = null;
            lease.State = lease.ConnectionCount > 0 ? AgentState.Available : AgentState.Offline;
            lease.HeartbeatAt = DateTimeOffset.UtcNow;
            return true;
        }
    }

    /// <summary>Mark stale heartbeats Offline; returns released call ids for redispatch.</summary>
    public IReadOnlyList<(string ClinicId, string UserId, Guid CallId)> SweepStale()
    {
        var now = DateTimeOffset.UtcNow;
        var released = new List<(string, string, Guid)>();
        foreach (var lease in _agents.Values)
        {
            lock (lease.SyncRoot)
            {
                if (lease.ConnectionCount <= 0) continue;
                if (now - lease.HeartbeatAt <= _staleAfter) continue;
                if (lease.ReservedCallId is Guid callId)
                    released.Add((lease.ClinicId, lease.UserId, callId));
                lease.ConnectionCount = 0;
                lease.State = AgentState.Offline;
                lease.ReservedCallId = null;
            }
        }
        return released;
    }

    public PresenceSnapshot SnapshotForClinic(IdentityRegistry identities, string clinicId)
    {
        var members = identities.DirectoryForClinic(clinicId, includeLoadUsers: false)
            .Where(i => i.Role == IdentityRoles.Staff)
            .Select(i =>
            {
                var lease = Find(clinicId, i.Id);
                if (lease is null)
                    return new PresenceUser(i.Id, false, AgentState.Offline.ToString(), null, null);
                lock (lease.SyncRoot)
                {
                    var online = lease.ConnectionCount > 0 && lease.State != AgentState.Offline;
                    return new PresenceUser(
                        i.Id, online, lease.State.ToString(),
                        lease.ReservedCallId, lease.LastAssignedAt);
                }
            })
            .ToArray();
        return new PresenceSnapshot(clinicId, members);
    }
}

public sealed record PresenceUser(
    string UserId,
    bool Online,
    string State = "Offline",
    Guid? ReservedCallId = null,
    DateTimeOffset? LastAssignedAt = null);

/// <summary>ClinicId is canonical; TenantId is a compatibility alias.</summary>
public sealed record PresenceSnapshot(string ClinicId, IReadOnlyList<PresenceUser> Users)
{
    public string TenantId => ClinicId;
}

public sealed record AgentView(
    string UserId,
    string ClinicId,
    string State,
    bool Online,
    DateTimeOffset HeartbeatAt,
    Guid? ReservedCallId,
    DateTimeOffset? LastAssignedAt);
