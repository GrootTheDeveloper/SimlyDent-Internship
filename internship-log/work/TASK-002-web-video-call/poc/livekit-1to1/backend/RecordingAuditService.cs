using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

public sealed class RecordingAuditService
{
    private readonly ConcurrentQueue<RecordingAuditEvent> _events = new();
    private readonly string? _logPath;

    public RecordingAuditService(IConfiguration configuration)
    {
        var root = configuration["RECORDINGS_PATH"] ?? "/recordings";
        try
        {
            Directory.CreateDirectory(root);
            _logPath = Path.Combine(root, "recording-audit.jsonl");
        }
        catch
        {
            _logPath = null;
        }
    }

    public void Append(
        string clinicId,
        Guid? callId,
        string? recordingId,
        string actorId,
        string actorRole,
        string action,
        string result,
        string? detail = null)
    {
        var ev = new RecordingAuditEvent(
            Guid.NewGuid().ToString("N"),
            DateTimeOffset.UtcNow,
            clinicId,
            callId,
            recordingId,
            actorId,
            actorRole,
            action,
            result,
            detail);
        _events.Enqueue(ev);
        if (_logPath is null) return;
        try
        {
            var line = System.Text.Json.JsonSerializer.Serialize(ev);
            File.AppendAllText(_logPath, line + Environment.NewLine);
        }
        catch
        {
            // Audit must not break call path.
        }
    }

    public IReadOnlyList<RecordingAuditEvent> Snapshot(string? clinicId = null, int take = 200)
    {
        var all = _events.ToArray();
        IEnumerable<RecordingAuditEvent> q = all;
        if (!string.IsNullOrWhiteSpace(clinicId))
            q = q.Where(e => string.Equals(e.ClinicId, clinicId, StringComparison.OrdinalIgnoreCase));
        return q.Reverse().Take(take).ToArray();
    }
}
