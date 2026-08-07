using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

/// <summary>
/// Result of an atomic call/agent transition.
/// </summary>
public enum CallTransitionKind
{
    Ok,
    Conflict,
    Forbidden,
    NotFound
}

public readonly record struct CallTransitionResult(
    CallTransitionKind Kind,
    CallSession? Call,
    string? Error)
{
    public static CallTransitionResult Ok(CallSession call) =>
        new(CallTransitionKind.Ok, call, null);

    public static CallTransitionResult Conflict(CallSession? call, string error) =>
        new(CallTransitionKind.Conflict, call, error);

    public static CallTransitionResult Forbidden(string error) =>
        new(CallTransitionKind.Forbidden, null, error);

    public static CallTransitionResult NotFound() =>
        new(CallTransitionKind.NotFound, null, null);
}

/// <summary>
/// Clinic FIFO queue + longest-idle auto-dispatch (TASK-003 Phase 1).
/// Accept / timeout / reject / cancel / end are atomic under clinic + call locks.
/// </summary>
public sealed class CallDispatcher(
    ConcurrentDictionary<Guid, CallSession> calls,
    AgentRegistry agents,
    IdentityRegistry identities,
    IHubContext<CallHub> hub,
    IConfiguration configuration,
    RecordingPolicyRegistry recordingPolicies)
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

    private readonly bool _alwaysOpen =
        !string.Equals(configuration["CLINIC_FORCE_CLOSED"], "1", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Embed visitor stopped polling while Queued/Ringing — free queue slot soon (default 30s).
    /// </summary>
    private readonly TimeSpan _visitorStaleWaiting = TimeSpan.FromSeconds(
        Math.Clamp(
            int.TryParse(
                configuration["EMBED_VISITOR_STALE_WAITING_SECONDS"]
                ?? configuration["EMBED_VISITOR_STALE_SECONDS"],
                out var sw)
                ? sw
                : 30,
            15, 300));

    /// <summary>
    /// Embed visitor stopped polling while Accepted — allow reload recovery (default 90s).
    /// </summary>
    private readonly TimeSpan _visitorStaleInCall = TimeSpan.FromSeconds(
        Math.Clamp(
            int.TryParse(
                configuration["EMBED_VISITOR_STALE_INCALL_SECONDS"]
                ?? configuration["EMBED_VISITOR_STALE_SECONDS"],
                out var si)
                ? si
                : 90,
            30, 600));

    public TimeSpan RingTimeout => _ringTimeout;
    public TimeSpan VisitorTimeout => _visitorTimeout;
    public TimeSpan VisitorStaleWaiting => _visitorStaleWaiting;
    public TimeSpan VisitorStaleInCall => _visitorStaleInCall;

    private object ClinicLock(string clinicId) =>
        _clinicLocks.GetOrAdd(clinicId.Trim().ToLowerInvariant(), _ => new object());

    public bool IsClinicOpen(string clinicId) => _alwaysOpen;

    public async Task<CallSession> EnqueueAsync(
        TestIdentity visitor,
        string initialMediaMode = "Video",
        CancellationToken ct = default)
    {
        if (visitor.Role != IdentityRoles.Visitor && visitor.Role != IdentityRoles.Staff)
            throw new InvalidOperationException("Only clinic principals may enqueue.");

        var mediaMode = CallSession.NormalizeMediaMode(initialMediaMode);

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
                Status = CallStatus.Closed,
                VisitorLastSeenAt = DateTimeOffset.UtcNow,
                RecordingMode = recordingPolicies.Get(visitor.ClinicId).DefaultMode,
                InitialMediaMode = mediaMode
            };
            calls[closedId] = closed;
            await NotifyCallAsync(closed);
            await BroadcastQueueAsync(visitor.ClinicId);
            return closed;
        }

        // Atomic: 1 session/visitor ≤ 1 active queue call (check + create under clinic lock).
        CallSession call;
        var created = false;
        lock (ClinicLock(visitor.ClinicId))
        {
            var existing = calls.Values.FirstOrDefault(c =>
                c.BelongsToClinic(visitor.ClinicId)
                && c.Origin == CallOrigin.Queue
                && string.Equals(c.CallerId, visitor.Id, StringComparison.OrdinalIgnoreCase)
                && c.IsActive);
            if (existing is not null)
            {
                lock (existing.SyncRoot)
                {
                    existing.VisitorLastSeenAt = DateTimeOffset.UtcNow;
                    // Still waiting: honor latest join preference (Audio vs Video) from widget re-tap.
                    if (existing.Status is CallStatus.Queued or CallStatus.Ringing)
                        existing.InitialMediaMode = mediaMode;
                }
                call = existing;
            }
            else
            {
                var id = Guid.NewGuid();
                call = new CallSession
                {
                    Id = id,
                    ClinicId = visitor.ClinicId,
                    CallerId = visitor.Id,
                    CalleeId = "",
                    Origin = CallOrigin.Queue,
                    RoomName = CallSession.BuildRoomName(visitor.ClinicId, id),
                    Status = CallStatus.Queued,
                    VisitorLastSeenAt = DateTimeOffset.UtcNow,
                    RecordingMode = recordingPolicies.Get(visitor.ClinicId).DefaultMode,
                    InitialMediaMode = mediaMode
                };
                calls[id] = call;
                created = true;
            }
        }

        if (created)
        {
            await TryDispatchClinicAsync(visitor.ClinicId, ct);
            await BroadcastQueueAsync(visitor.ClinicId);
            await NotifyCallAsync(call);
        }
        return call;
    }

    public bool TryAssignDirect(CallSession call, string staffUserId)
    {
        lock (ClinicLock(call.ClinicId))
        {
            if (agents.IsBusy(call.ClinicId, staffUserId))
                return false;

            agents.TryReserve(call.ClinicId, staffUserId, call.Id);

            lock (call.SyncRoot)
            {
                call.Status = CallStatus.Ringing;
                call.CalleeId = staffUserId;
                call.AssignedStaffId = staffUserId;
                call.AssignmentEpoch++;
                call.RingingStartedAt = DateTimeOffset.UtcNow;
                call.UpdatedAt = DateTimeOffset.UtcNow;
                call.TriedStaffIds.Add(staffUserId);
            }
            return true;
        }
    }

    public async Task TryDispatchClinicAsync(string clinicId, CancellationToken ct = default)
    {
        lock (ClinicLock(clinicId))
        {
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
                    if (staffId is null && next.TriedStaffIds.Count > 0)
                    {
                        next.TriedStaffIds.Clear();
                        staffId = agents.TryReserveLongestIdle(
                            clinicId, next.Id, next.TriedStaffIds, identities);
                    }
                    if (staffId is null)
                        break;

                    next.Status = CallStatus.Ringing;
                    next.CalleeId = staffId;
                    next.AssignedStaffId = staffId;
                    next.AssignmentEpoch++;
                    next.RingingStartedAt = DateTimeOffset.UtcNow;
                    next.UpdatedAt = DateTimeOffset.UtcNow;
                    next.TriedStaffIds.Add(staffId);
                }
            }
        }

        foreach (var call in calls.Values.Where(c =>
                     c.BelongsToClinic(clinicId) && c.IsActive))
        {
            await NotifyCallAsync(call);
        }
        await BroadcastQueueAsync(clinicId);
        await BroadcastAgentsAsync(clinicId);
    }

    /// <summary>
    /// Atomic Accept: clinic lock → call lock → lease. Lost races return Conflict.
    /// </summary>
    public async Task<CallTransitionResult> TryAcceptAsync(Guid callId, TestIdentity staff)
    {
        if (!calls.TryGetValue(callId, out var call))
            return CallTransitionResult.NotFound();
        if (!call.BelongsToClinic(staff.ClinicId))
            return CallTransitionResult.NotFound();

        CallTransitionResult result;
        lock (ClinicLock(call.ClinicId))
        {
            lock (call.SyncRoot)
            {
                if (call.Status != CallStatus.Ringing)
                {
                    // Double accept / race with timeout → Conflict (not silent success).
                    result = CallTransitionResult.Conflict(
                        call, $"Call is no longer ringing (status={call.Status}).");
                }
                else if (!string.Equals(
                             call.AssignedStaffId ?? call.CalleeId,
                             staff.Id,
                             StringComparison.OrdinalIgnoreCase))
                {
                    result = CallTransitionResult.Forbidden("Only the assigned staff may accept this call.");
                }
                else if (!agents.TryMarkInCall(call.ClinicId, staff.Id, call.Id, force: true))
                {
                    result = CallTransitionResult.Conflict(call, "Staff is busy on another call.");
                }
                else
                {
                    call.Status = CallStatus.Accepted;
                    call.AcceptedBy = staff.Id;
                    call.AssignedStaffId = staff.Id;
                    call.CalleeId = staff.Id;
                    call.UpdatedAt = DateTimeOffset.UtcNow;
                    result = CallTransitionResult.Ok(call);
                }
            }
        }

        if (result.Kind == CallTransitionKind.Ok && result.Call is not null)
        {
            await NotifyCallAsync(result.Call);
            await BroadcastAgentsAsync(result.Call.ClinicId);
            await BroadcastQueueAsync(result.Call.ClinicId);
        }
        return result;
    }

    /// <summary>
    /// Atomic release of Ringing (reject / timeout / agent drop).
    /// No-op if call already left Ringing (e.g. accepted first).
    /// </summary>
    public async Task OnRingingReleasedAsync(
        CallSession call,
        CallStatus terminalIfDirect,
        CancellationToken ct = default,
        string? expectedStaffId = null,
        int? expectedEpoch = null)
    {
        var redispatch = false;
        var notify = false;

        lock (ClinicLock(call.ClinicId))
        {
            string? staffId = null;
            lock (call.SyncRoot)
            {
                if (call.Status != CallStatus.Ringing)
                    return; // lost race to Accept/Cancel — do not touch assignment

                staffId = call.AssignedStaffId ?? call.CalleeId;
                if (!string.IsNullOrEmpty(expectedStaffId)
                    && !string.Equals(staffId, expectedStaffId, StringComparison.OrdinalIgnoreCase))
                    return; // assignment already moved (e.g. redispatch)
                if (expectedEpoch is int epoch && call.AssignmentEpoch != epoch)
                    return; // stale reject/timeout for a prior reservation

                if (call.Origin == CallOrigin.Direct)
                {
                    call.Status = terminalIfDirect;
                    call.AssignedStaffId = null;
                    call.AssignmentEpoch++;
                    call.UpdatedAt = DateTimeOffset.UtcNow;
                    notify = true;
                }
                else
                {
                    var now = DateTimeOffset.UtcNow;
                    if (now - call.CreatedAt >= _visitorTimeout)
                    {
                        call.Status = CallStatus.Timeout;
                        call.AssignedStaffId = null;
                        call.CalleeId = "";
                        call.AssignmentEpoch++;
                        call.UpdatedAt = now;
                        notify = true;
                    }
                    else
                    {
                        call.Status = CallStatus.Queued;
                        call.AssignedStaffId = null;
                        call.CalleeId = "";
                        call.RingingStartedAt = null;
                        call.AssignmentEpoch++;
                        call.UpdatedAt = now;
                        notify = true;
                        redispatch = true;
                    }
                }
            }

            if (!string.IsNullOrEmpty(staffId))
                agents.TryRelease(call.ClinicId, staffId, call.Id);
        }

        if (!notify) return;
        await NotifyCallAsync(call);
        if (redispatch)
            await TryDispatchClinicAsync(call.ClinicId, ct);
        else
        {
            await BroadcastQueueAsync(call.ClinicId);
            await BroadcastAgentsAsync(call.ClinicId);
        }
    }

    /// <summary>
    /// Atomic Reject: validate assigned staff + epoch and release under the same clinic/call locks.
    /// </summary>
    public async Task<CallTransitionResult> TryRejectAsync(Guid callId, TestIdentity staff)
    {
        if (!calls.TryGetValue(callId, out var call))
            return CallTransitionResult.NotFound();
        if (!call.BelongsToClinic(staff.ClinicId))
            return CallTransitionResult.NotFound();

        string? releaseStaffId = null;
        var redispatch = false;
        CallTransitionResult result;

        lock (ClinicLock(call.ClinicId))
        {
            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Accepted)
                {
                    result = CallTransitionResult.Conflict(call, "Call was accepted concurrently.");
                }
                else if (call.Status != CallStatus.Ringing)
                {
                    result = CallTransitionResult.Conflict(call, "Call is no longer ringing.");
                }
                else if (!string.Equals(
                             call.AssignedStaffId ?? call.CalleeId,
                             staff.Id,
                             StringComparison.OrdinalIgnoreCase))
                {
                    result = CallTransitionResult.Forbidden("Only the assigned staff may reject this call.");
                }
                else
                {
                    releaseStaffId = call.AssignedStaffId ?? call.CalleeId;
                    if (call.Origin == CallOrigin.Direct)
                    {
                        call.Status = CallStatus.Rejected;
                        call.AssignedStaffId = null;
                        call.AssignmentEpoch++;
                        call.UpdatedAt = DateTimeOffset.UtcNow;
                    }
                    else
                    {
                        var now = DateTimeOffset.UtcNow;
                        if (now - call.CreatedAt >= _visitorTimeout)
                        {
                            call.Status = CallStatus.Timeout;
                            call.AssignedStaffId = null;
                            call.CalleeId = "";
                            call.AssignmentEpoch++;
                            call.UpdatedAt = now;
                        }
                        else
                        {
                            call.Status = CallStatus.Queued;
                            call.AssignedStaffId = null;
                            call.CalleeId = "";
                            call.RingingStartedAt = null;
                            call.AssignmentEpoch++;
                            call.UpdatedAt = now;
                            redispatch = true;
                        }
                    }
                    result = CallTransitionResult.Ok(call);
                }
            }

            if (result.Kind == CallTransitionKind.Ok && !string.IsNullOrEmpty(releaseStaffId))
                agents.TryRelease(call.ClinicId, releaseStaffId, call.Id);
        }

        if (result.Kind == CallTransitionKind.Ok)
        {
            await NotifyCallAsync(call);
            if (redispatch)
                await TryDispatchClinicAsync(call.ClinicId);
            else
            {
                await BroadcastQueueAsync(call.ClinicId);
                await BroadcastAgentsAsync(call.ClinicId);
            }
        }
        return result;
    }

    public async Task<CallTransitionResult> TryCancelAsync(Guid callId, TestIdentity actor)
    {
        if (!calls.TryGetValue(callId, out var call))
            return CallTransitionResult.NotFound();
        if (!call.BelongsToClinic(actor.ClinicId) || !call.Contains(actor.Id))
            return CallTransitionResult.NotFound();
        if (!string.Equals(call.CallerId, actor.Id, StringComparison.OrdinalIgnoreCase))
            return CallTransitionResult.Forbidden("Only the caller may cancel.");

        string? staffId = null;
        lock (ClinicLock(call.ClinicId))
        {
            lock (call.SyncRoot)
            {
                // Idempotent: already cancelled.
                if (call.Status == CallStatus.Cancelled)
                    return CallTransitionResult.Ok(call);
                if (call.Status is not (CallStatus.Ringing or CallStatus.Queued))
                    return CallTransitionResult.Conflict(call, $"Cannot cancel in status {call.Status}.");

                staffId = call.AssignedStaffId ?? call.CalleeId;
                call.Status = CallStatus.Cancelled;
                call.AssignedStaffId = null;
                call.AssignmentEpoch++;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }

            if (!string.IsNullOrEmpty(staffId))
                agents.TryRelease(call.ClinicId, staffId, call.Id);
        }

        await NotifyCallAsync(call);
        await BroadcastQueueAsync(call.ClinicId);
        await BroadcastAgentsAsync(call.ClinicId);
        await TryDispatchClinicAsync(call.ClinicId);
        return CallTransitionResult.Ok(call);
    }

    /// <summary>
    /// End Accepted call. Idempotent if already Ended.
    /// </summary>
    public async Task<CallTransitionResult> TryEndAsync(Guid callId, TestIdentity actor)
    {
        if (!calls.TryGetValue(callId, out var call))
            return CallTransitionResult.NotFound();
        if (!call.BelongsToClinic(actor.ClinicId) || !call.Contains(actor.Id))
            return CallTransitionResult.NotFound();

        string? staffId = null;
        string? egressId = null;
        lock (ClinicLock(call.ClinicId))
        {
            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Ended)
                    return CallTransitionResult.Ok(call);
                if (call.Status != CallStatus.Accepted)
                    return CallTransitionResult.Conflict(call, $"Cannot end in status {call.Status}.");

                staffId = call.AssignedStaffId ?? call.CalleeId;
                call.Status = CallStatus.Ended;
                call.UpdatedAt = DateTimeOffset.UtcNow;
                egressId = call.RecordingStatus == "Recording" ? call.RecordingEgressId : null;
                if (egressId is not null) call.RecordingStatus = "Stopping";
            }

            if (!string.IsNullOrEmpty(staffId))
                agents.TryRelease(call.ClinicId, staffId, call.Id);
        }

        await NotifyCallAsync(call);
        await BroadcastAgentsAsync(call.ClinicId);
        await TryDispatchClinicAsync(call.ClinicId);
        return CallTransitionResult.Ok(call);
    }

    public async Task SweepAsync(CancellationToken ct = default)
    {
        var now = DateTimeOffset.UtcNow;

        foreach (var (clinicId, userId, callId) in agents.SweepStale())
        {
            if (!calls.TryGetValue(callId, out var call)) continue;
            if (!call.BelongsToClinic(clinicId)) continue;
            await OnRingingReleasedAsync(call, CallStatus.Cancelled, ct);
        }

        foreach (var call in calls.Values.Where(c => c.IsActive).ToArray())
        {
            if (ct.IsCancellationRequested) break;

            // Embed visitor disappeared (no poll) — free queue / staff.
            // Waiting (Queued/Ringing): shorter threshold (default 30s) to clear ghost queue.
            // In-call (Accepted): longer threshold (default 90s) for reload recovery.
            if (call.Origin == CallOrigin.Queue
                && call.CallerId.StartsWith("visitor:", StringComparison.OrdinalIgnoreCase))
            {
                DateTimeOffset lastSeen;
                CallStatus status;
                lock (call.SyncRoot)
                {
                    lastSeen = call.VisitorLastSeenAt ?? call.UpdatedAt;
                    status = call.Status;
                }
                var staleAfter = status == CallStatus.Accepted
                    ? _visitorStaleInCall
                    : _visitorStaleWaiting;
                if (now - lastSeen >= staleAfter)
                {
                    await AbandonStaleVisitorAsync(call, ct);
                    continue;
                }
            }

            if (call.Origin == CallOrigin.Queue && call.Status == CallStatus.Queued
                && now - call.CreatedAt >= _visitorTimeout)
            {
                lock (ClinicLock(call.ClinicId))
                {
                    lock (call.SyncRoot)
                    {
                        if (call.Status != CallStatus.Queued) continue;
                        call.Status = CallStatus.Timeout;
                        call.UpdatedAt = now;
                    }
                }
                await NotifyCallAsync(call);
                await BroadcastQueueAsync(call.ClinicId);
                continue;
            }

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

    /// <summary>
    /// Visitor stopped polling: cancel Queued/Ringing, end Accepted, free staff + redispatch.
    /// </summary>
    public async Task AbandonStaleVisitorAsync(CallSession call, CancellationToken ct = default)
    {
        CallStatus status;
        lock (call.SyncRoot)
            status = call.Status;

        var actor = new TestIdentity(
            call.CallerId, call.ClinicId, "Visitor", IdentityRoles.Visitor);

        if (status is CallStatus.Queued or CallStatus.Ringing)
        {
            await TryCancelAsync(call.Id, actor);
            return;
        }

        if (status == CallStatus.Accepted)
        {
            await TryEndAsync(call.Id, actor);
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
                // Staff-friendly label (avoid full visitor:{guid} in UI).
                CallerLabel = FormatCallerLabel(c.CallerId),
                c.Status,
                c.AssignedStaffId,
                c.CreatedAt,
                WaitingSeconds = (int)(DateTimeOffset.UtcNow - c.CreatedAt).TotalSeconds
            })
            .ToArray();
        return new { clinicId, items };
    }

    /// <summary>Short label for staff queue/UI; internal id stays on CallerId.</summary>
    public static string FormatCallerLabel(string? callerId)
    {
        if (string.IsNullOrWhiteSpace(callerId)) return "Khách";
        if (callerId.StartsWith("visitor:", StringComparison.OrdinalIgnoreCase))
        {
            var hex = new string(callerId.AsSpan("visitor:".Length)
                .ToArray()
                .Where(char.IsLetterOrDigit)
                .Take(6)
                .ToArray());
            if (hex.Length == 0) return "Khách web";
            return $"Khách #{hex.ToUpperInvariant()}";
        }
        if (callerId.StartsWith("V", StringComparison.OrdinalIgnoreCase)
            && callerId.Length <= 4)
            return $"Khách {callerId.ToUpperInvariant()}";
        return callerId;
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
