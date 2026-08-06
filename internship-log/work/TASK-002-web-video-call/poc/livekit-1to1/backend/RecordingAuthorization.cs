using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Recording ACL separate from call-participant authorization.
/// Manager same clinic: download/delete. Staff participant: start/stop only. Visitor: consent only.
/// </summary>
public static class RecordingAuthorization
{
    public static bool IsManager(TestIdentity? user) =>
        user is not null
        && string.Equals(user.Role, IdentityRoles.Manager, StringComparison.OrdinalIgnoreCase);

    public static bool IsDispatchableStaff(TestIdentity? user) =>
        ClinicAuthorization.IsStaff(user);

    public static IResult? RequireManager(TestIdentity? user)
    {
        if (user is null) return Results.Unauthorized();
        if (!IsManager(user))
            return Results.Json(new { error = "Manager role required." }, statusCode: 403);
        return null;
    }

    /// <summary>Staff or Manager of a clinic (overview / policy read).</summary>
    public static IResult? RequireStaffOrManager(TestIdentity? user)
    {
        if (user is null) return Results.Unauthorized();
        if (ClinicAuthorization.IsStaff(user) || IsManager(user))
            return null;
        return Results.Json(new { error = "Staff or Manager role required." }, statusCode: 403);
    }

    /// <summary>
    /// Same-clinic call for Manager (not required to be participant).
    /// Cross-clinic → null (404).
    /// </summary>
    public static CallSession? GetClinicCallForManager(
        ConcurrentDictionary<Guid, CallSession> calls,
        Guid callId,
        TestIdentity manager)
    {
        if (!IsManager(manager)) return null;
        return ClinicAuthorization.TryGetClinicCall(calls, callId, manager);
    }

    public static bool CanStartStop(TestIdentity actor, CallSession call)
    {
        if (!call.BelongsToClinic(actor.ClinicId)) return false;
        if (IsManager(actor)) return false; // start/stop is staff participant
        if (!ClinicAuthorization.IsStaff(actor)) return false;
        return call.Contains(actor.Id);
    }

    public static bool CanDownloadOrDelete(TestIdentity actor, CallSession call)
    {
        if (!IsManager(actor)) return false;
        return call.BelongsToClinic(actor.ClinicId);
    }

    public static bool CanViewBusinessState(TestIdentity actor, CallSession call)
    {
        if (!call.BelongsToClinic(actor.ClinicId)) return false;
        if (IsManager(actor)) return true;
        if (ClinicAuthorization.IsStaff(actor) && call.Contains(actor.Id)) return true;
        return false;
    }

    public static RecordingView BuildView(CallSession call, TestIdentity? actor, RecordingPolicy policy)
    {
        var mode = call.RecordingMode.ToString();
        var status = call.RecordingStatus;
        var consent = call.ConsentStatus.ToString();

        var canStart = false;
        var canStop = false;
        var canDownload = false;
        var canDelete = false;

        if (actor is not null && call.BelongsToClinic(actor.ClinicId))
        {
            if (CanStartStop(actor, call))
            {
                canStart = call.Status == CallStatus.Accepted
                           && call.RecordingMode != RecordingMode.None
                           && policy.IsModeAllowed(call.RecordingMode)
                           && (!policy.RequireConsent || call.ConsentStatus == ConsentStatus.Granted)
                           && call.RecordingStatus is "Idle" or "Failed" or "Complete" or "Deleted";
                canStop = call.RecordingStatus is "Recording" or "Starting";
            }

            if (CanDownloadOrDelete(actor, call))
            {
                canDownload = call.RecordingStatus == "Complete"
                              && !string.IsNullOrWhiteSpace(call.RecordingStorageKey);
                canDelete = call.RecordingStatus == "Deleted"
                            || (call.RecordingStatus is "Complete" or "Failed"
                                && !string.IsNullOrWhiteSpace(call.RecordingStorageKey));
            }
        }

        return new RecordingView(
            mode,
            status,
            consent,
            call.ConsentGrantedAt,
            call.ConsentActorId,
            call.ConsentPolicyVersion,
            canStart,
            canStop,
            canDownload,
            canDelete);
    }

    /// <summary>Validate start preconditions (does not touch egress).</summary>
    public static string? ValidateStart(CallSession call, RecordingPolicy policy)
    {
        if (call.Status != CallStatus.Accepted)
            return "Recording is available only during an accepted call.";
        if (call.RecordingMode == RecordingMode.None)
            return "Recording mode is None — change mode before starting.";
        if (!policy.IsModeAllowed(call.RecordingMode))
            return "Recording mode is not allowed by clinic policy.";
        if (policy.RequireConsent && call.ConsentStatus != ConsentStatus.Granted)
            return "Consent must be Granted before recording can start.";
        if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
            return "This call is already being recorded.";
        return null;
    }
}
