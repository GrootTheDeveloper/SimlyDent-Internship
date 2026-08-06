using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

/// <summary>
/// Clinic FIFO queue + longest-idle auto-dispatch (TASK-003 Phase 1).
/// Selection is always server-side; never trusts client routing indexes.
/// </summary>
public sealed class CallDispatcher(
    ConcurrentDictionary<Guid, CallSession> calls,
    AgentRegistry agents,
    IdentityRegistry identities,
    IHubContext<CallHub> hub,
    IConfiguration configuration)
{
    private readonly ConcurrentDictionary<string, object> _clinicLocks =
        new(StringComparer.OrdinalIgnoreCase);

    private readonly TimeSpan _ringTimeout = TimeSpan.FromSeconds(
        Math.Clamp(
            int.TryParse(configuration["RING_TIMEOUT_SECONDS"], out var r) ? r : 15,
            5, 120));

    private readonly TimeSpan _visitorTimeout = TimeSpan.FromSeconds(
        Math.Clamp(
            int.TryParse(configuration["VISITOR_TIMEOUT_SECONDS"], out var v) ? v : 120,
            30, 3600));

    // Working hours stub: always open for Phase 1 PoC unless explicitly disabled.
    private readonly bool _alwaysOpen =
        !string.Equals(configuration["CLINIC_FORCE_CLOSED"], "1", StringComparison.OrdinalIgnoreCase);

    public TimeSpan RingTimeout => _ringTimeout;
    public TimeSpan VisitorTimeout => _visitorTimeout;

    private object ClinicLock(string clinicId) =>
        _clinicLocks.GetOrAdd(clinicId.Trim().ToLowerInvariant(), _ => new object());

    public bool IsClinicOpen(string clinicId) => _alwaysOpen;

    /// <summary>
    /// Enqueue a queue-origin call and attempt immediate dispatch.
    /// Caller must already be authenticated and clinic-scoped.
    /// </summary>
    public async Task<CallSession> EnqueueAsync(TestIdentity visitor, CancellationToken ct = default)
    {
        if (visitor.Role != IdentityRoles.Visitor && visitor.Role != IdentityRoles.Staff)
            throw new InvalidOperationException("Only clinic principals may enqueue.");

        if (!IsClinicOpen(visitor.ClinicId))
        {
            var closedId = Guid.NewGuid();
            var closed = new CallSession
            {
                Id = closedId,
                ClinicId = visitor.ClinicId,
                CallerId = visitor.Id,
                CalleeId = "",
                Origin = CallOrigin.Queue,
                RoomName = CallSession.BuildRoomName(visitor.ClinicId, closedId),
                Status = CallStatus.Closed
            };
            calls[closedId] = closed;
            await NotifyCallAsync(closed);
            await BroadcastQueueAsync(visitor.ClinicId);
            return closed;
        }

        // One active queue/call per visitor.
        var existing = calls.Values.FirstOrDefault(c =>
            c.BelongsToClinic(visitor.ClinicId)
            && c.Origin == CallOrigin.Queue
            && c.CallerId == visitor.Id
            && c.IsActive);
        if (existing is not null)
            return existing;

        var id = Guid.NewGuid();
        var call = new CallSession
        {
            Id = id,
            ClinicId = visitor.ClinicId,
            CallerId = visitor.Id,
            CalleeId = "",
            Origin = CallOrigin.Queue,
            RoomName = CallSession.BuildRoomName(visitor.ClinicId, id),
            Status = CallStatus.Queued
        };
        calls[id] = call;

        await TryDispatchClinicAsync(visitor.ClinicId, ct);
        await BroadcastQueueAsync(visitor.ClinicId);
        await NotifyCallAsync(call);
        return call;
    }

    /// <summary>
    /// Direct staff→staff: prefer agent lease reserve.
    /// If staff is busy (Ringing/InCall) → fail.
    /// If staff offline/Available race → still ring the call (HTTP smoke / offline callee UX)
    /// without blocking the classic 1:1 path.
    /// </summary>
    public bool TryAssignDirect(CallSession call, string staffUserId)
    {
        if (agents.IsBusy(call.ClinicId, staffUserId))
            return false;

        // Best-effort lease; not required for offline direct ring.
        agents.TryReserve(call.ClinicId, staffUserId, call.Id);

        lock (call.SyncRoot)
        {
            call.Status = CallStatus.Ringing;
            call.CalleeId = staffUserId;
            call.AssignedStaffId = staffUserId;
            call.RingingStartedAt = DateTimeOffset.UtcNow;
            call.UpdatedAt = DateTimeOffset.UtcNow;
            call.TriedStaffIds.Add(staffUserId);
        }
        return true;
    }

    public async Task TryDispatchClinicAsync(string clinicId, CancellationToken ct = default)
    {
        lock (ClinicLock(clinicId))
        {
            // Drain: assign each Queued call while Available staff exist.
            while (true)
            {
                var next = calls.Values
                    .Where(c => c.BelongsToClinic(clinicId)
                                && c.Origin == CallOrigin.Queue
                                && c.Status == CallStatus.Queued)
                    .OrderBy(c => c.CreatedAt)
                    .FirstOrDefault();
                if (next is null) break;

                string? staffId;
                lock (next.SyncRoot)
                {
                    if (next.Status != CallStatus.Queued) break;
                    staffId = agents.TryReserveLongestIdle(
                        clinicId, next.Id, next.TriedStaffIds, identities);
                    // All candidates already tried and free again → reset cycle.
                    if (staffId is null && next.TriedStaffIds.Count > 0)
                    {
                        next.TriedStaffIds.Clear();
                        staffId = agents.TryReserveLongestIdle(
                            clinicId, next.Id, next.TriedStaffIds, identities);
                    }
                    if (staffId is null)
                        break; // no Available staff — remain Queued

                    next.Status = CallStatus.Ringing;
                    next.CalleeId = staffId;
                    next.AssignedStaffId = staffId;
                    next.RingingStartedAt = DateTimeOffset.UtcNow;
                    next.UpdatedAt = DateTimeOffset.UtcNow;
                    next.TriedStaffIds.Add(staffId);
                }
            }
        }

        // Notify outside clinic lock.
        foreach (var call in calls.Values.Where(c =>
                     c.BelongsToClinic(clinicId) && c.IsActive))
        {
            await NotifyCallAsync(call);
        }
        await BroadcastQueueAsync(clinicId);
        await BroadcastAgentsAsync(clinicId);
    }

    public async Task OnAcceptAsync(CallSession call, TestIdentity staff)
    {
        // force: allows accept after offline direct-ring (no prior lease).
        if (!agents.TryMarkInCall(call.ClinicId, staff.Id, call.Id, force: true))
            throw new InvalidOperationException("Staff is busy on another call.");
        lock (call.SyncRoot)
        {
            call.Status = CallStatus.Accepted;
            call.AcceptedBy = staff.Id;
            call.AssignedStaffId = staff.Id;
            call.CalleeId = staff.Id;
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await NotifyCallAsync(call);
        await BroadcastAgentsAsync(call.ClinicId);
        await BroadcastQueueAsync(call.ClinicId);
    }

    /// <summary>
    /// Reject / ring-timeout / agent offline while Ringing.
    /// Direct → terminal Rejected/Cancelled path handled by caller for Rejected.
    /// Queue → release staff and redispatch or re-queue.
    /// </summary>
    public async Task OnRingingReleasedAsync(
        CallSession call,
        CallStatus terminalIfDirect,
        CancellationToken ct = default)
    {
        string? staffId;
        lock (call.SyncRoot)
        {
            staffId = call.AssignedStaffId ?? call.CalleeId;
        }

        if (!string.IsNullOrEmpty(staffId))
            agents.TryRelease(call.ClinicId, staffId, call.Id);

        if (call.Origin == CallOrigin.Direct)
        {
            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Ringing)
                {
                    call.Status = terminalIfDirect;
                    call.AssignedStaffId = null;
                    call.UpdatedAt = DateTimeOffset.UtcNow;
                }
            }
            await NotifyCallAsync(call);
            await BroadcastAgentsAsync(call.ClinicId);
            return;
        }

        // Queue: re-queue if still within visitor timeout, else NoAgent/Timeout.
        var now = DateTimeOffset.UtcNow;
        lock (call.SyncRoot)
        {
            if (call.Status != CallStatus.Ringing) return;
            if (now - call.CreatedAt >= _visitorTimeout)
            {
                call.Status = CallStatus.Timeout;
                call.AssignedStaffId = null;
                call.CalleeId = "";
                call.UpdatedAt = now;
            }
            else
            {
                call.Status = CallStatus.Queued;
                call.AssignedStaffId = null;
                call.CalleeId = "";
                call.RingingStartedAt = null;
                call.UpdatedAt = now;
            }
        }

        await NotifyCallAsync(call);
        if (call.Status == CallStatus.Queued)
            await TryDispatchClinicAsync(call.ClinicId, ct);
        else
        {
            await BroadcastQueueAsync(call.ClinicId);
            await BroadcastAgentsAsync(call.ClinicId);
        }
    }

    public async Task OnEndAsync(CallSession call, CancellationToken ct = default)
    {
        string? staffId;
        lock (call.SyncRoot)
        {
            staffId = call.AssignedStaffId ?? call.CalleeId;
        }
        if (!string.IsNullOrEmpty(staffId))
            agents.TryRelease(call.ClinicId, staffId, call.Id);

        await NotifyCallAsync(call);
        await BroadcastAgentsAsync(call.ClinicId);
        // Immediately pull queue head for this clinic.
        await TryDispatchClinicAsync(call.ClinicId, ct);
    }

    public async Task OnCancelAsync(CallSession call, CancellationToken ct = default)
    {
        string? staffId;
        lock (call.SyncRoot)
        {
            staffId = call.AssignedStaffId ?? call.CalleeId;
            if (call.Status is CallStatus.Queued or CallStatus.Ringing)
            {
                call.Status = CallStatus.Cancelled;
                call.AssignedStaffId = null;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }
        }
        if (!string.IsNullOrEmpty(staffId))
            agents.TryRelease(call.ClinicId, staffId, call.Id);

        await NotifyCallAsync(call);
        await BroadcastQueueAsync(call.ClinicId);
        await BroadcastAgentsAsync(call.ClinicId);
        await TryDispatchClinicAsync(call.ClinicId, ct);
    }

    /// <summary>Background sweep: ring timeouts, visitor timeouts, stale agents.</summary>
    public async Task SweepAsync(CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;

        // Stale heartbeats → Offline + release.
        foreach (var (clinicId, userId, callId) in agents.SweepStale())
        {
            if (!calls.TryGetValue(callId, out var call)) continue;
            if (!call.BelongsToClinic(clinicId)) continue;
            await OnRingingReleasedAsync(call, CallStatus.Cancelled, ct);
        }

        foreach (var call in calls.Values.Where(c => c.IsActive).ToArray())
        {
            if (ct.IsCancellationRequested) break;

            // Visitor timeout while Queued.
            if (call.Origin == CallOrigin.Queue && call.Status == CallStatus.Queued
                && now - call.CreatedAt >= _visitorTimeout)
            {
                lock (call.SyncRoot)
                {
                    if (call.Status != CallStatus.Queued) continue;
                    call.Status = CallStatus.Timeout;
                    call.UpdatedAt = now;
                }
                await NotifyCallAsync(call);
                await BroadcastQueueAsync(call.ClinicId);
                continue;
            }

            // Ring timeout.
            if (call.Status == CallStatus.Ringing
                && call.RingingStartedAt is DateTimeOffset started
                && now - started >= _ringTimeout)
            {
                await OnRingingReleasedAsync(
                    call,
                    call.Origin == CallOrigin.Direct ? CallStatus.Cancelled : CallStatus.Rejected,
                    ct);
            }
        }
    }

    public object QueueSnapshot(string clinicId)
    {
        var items = calls.Values
            .Where(c => c.BelongsToClinic(clinicId)
                        && c.Origin == CallOrigin.Queue
                        && c.Status is CallStatus.Queued or CallStatus.Ringing)
            .OrderBy(c => c.CreatedAt)
            .Select(c => new
            {
                c.Id,
                c.CallerId,
                c.Status,
                c.AssignedStaffId,
                c.CreatedAt,
                WaitingSeconds = (int)(DateTimeOffset.UtcNow - c.CreatedAt).TotalSeconds
            })
            .ToArray();
        return new { clinicId, items };
    }

    public Task NotifyCallAsync(CallSession call)
    {
        var view = call.ToView();
        var tasks = new List<Task>
        {
            hub.Clients.Group(CallHub.Group(call.ClinicId, call.CallerId))
                .SendAsync("CallUpdated", view)
        };
        var staff = call.AssignedStaffId ?? call.CalleeId;
        if (!string.IsNullOrEmpty(staff)
            && !string.Equals(staff, call.CallerId, StringComparison.OrdinalIgnoreCase))
        {
            tasks.Add(hub.Clients.Group(CallHub.Group(call.ClinicId, staff))
                .SendAsync("CallUpdated", view));
        }
        return Task.WhenAll(tasks);
    }

    public Task BroadcastQueueAsync(string clinicId) =>
        hub.Clients.Group(CallHub.ClinicGroup(clinicId))
            .SendAsync("QueueUpdated", QueueSnapshot(clinicId));

    public Task BroadcastAgentsAsync(string clinicId) =>
        hub.Clients.Group(CallHub.ClinicGroup(clinicId))
            .SendAsync(CallHub.PresenceEvent, agents.SnapshotForClinic(identities, clinicId));
}
