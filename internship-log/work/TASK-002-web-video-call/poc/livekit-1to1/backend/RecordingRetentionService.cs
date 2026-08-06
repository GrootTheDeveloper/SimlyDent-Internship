using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Periodic retention cleanup. Never deletes active (Starting/Recording/Stopping) recordings.
/// </summary>
public sealed class RecordingRetentionService(
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    IRecordingStorage storage,
    RecordingAuditService audit,
    ILogger<RecordingRetentionService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // First run after short delay; then hourly.
        await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                RunOnce();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Recording retention sweep failed (call path unaffected).");
            }

            try
            {
                await Task.Delay(TimeSpan.FromHours(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    public int RunOnce()
    {
        var deleted = 0;
        var now = DateTimeOffset.UtcNow;
        foreach (var call in calls.Values)
        {
            string? key;
            string status;
            DateTimeOffset updated;
            string clinicId;
            Guid callId;
            string? recordingId;
            lock (call.SyncRoot)
            {
                status = call.RecordingStatus;
                key = call.RecordingStorageKey;
                updated = call.UpdatedAt;
                clinicId = call.ClinicId;
                callId = call.Id;
                recordingId = call.RecordingId;
                if (status is "Starting" or "Recording" or "Stopping")
                    continue;
                if (status is not ("Complete" or "Failed"))
                    continue;
                if (string.IsNullOrWhiteSpace(key))
                    continue;
            }

            var policy = policies.Get(clinicId);
            var age = now - updated;
            if (age < TimeSpan.FromDays(policy.RetentionDays))
                continue;

            try
            {
                storage.DeleteAsync(key!, CancellationToken.None).GetAwaiter().GetResult();
            }
            catch (Exception ex)
            {
                audit.Append(clinicId, callId, recordingId, "system", "System",
                    "RecordingExpired", "Failed", ex.Message);
                continue;
            }

            lock (call.SyncRoot)
            {
                call.RecordingStatus = "Deleted";
                call.RecordingStorageKey = null;
                call.RecordingFileName = null;
                call.RecordingEgressId = null;
                call.UpdatedAt = DateTimeOffset.UtcNow;
            }

            audit.Append(clinicId, callId, recordingId, "system", "System",
                "RecordingExpired", "Ok", $"retentionDays={policy.RetentionDays}");
            deleted++;
        }
        return deleted;
    }
}
