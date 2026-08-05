using System.Collections.Concurrent;
using LiveKitPoc.Api;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .WithOrigins("http://localhost:5173")
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));
builder.Services.AddSignalR();
builder.Services.AddSingleton<IdentityRegistry>();
builder.Services.AddSingleton<LiveKitTokenService>();
builder.Services.AddSingleton<CallQualityStore>();
builder.Services.AddSingleton<ConcurrentDictionary<Guid, CallSession>>();
builder.Services.AddHttpClient<LiveKitEgressService>();

var app = builder.Build();
app.UseCors();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));
app.MapGet("/api/identities", (IdentityRegistry registry) => Results.Ok(registry.All));

app.MapPost("/api/calls", async (
    HttpRequest request,
    CreateCallRequest body,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IHubContext<CallHub> hub) =>
{
    var caller = CurrentIdentity(request, identities);
    if (caller is null) return Results.Unauthorized();
    var callee = identities.Find(body.CalleeId);
    if (callee is null) return Results.BadRequest(new { error = "Unknown callee." });
    if (caller.Id == callee.Id) return Results.BadRequest(new { error = "Self-call is not allowed." });
    if (caller.TenantId != callee.TenantId)
        return Results.Json(new { error = "Cross-tenant call denied." }, statusCode: 403);

    var now = DateTimeOffset.UtcNow;
    var busy = calls.Values.Any(call => {
        if (!call.IsActive) return false;
        var timeout = call.Status == CallStatus.Ringing ? TimeSpan.FromSeconds(45) : TimeSpan.FromMinutes(2);
        if (now - call.UpdatedAt > timeout)
        {
            lock (call.SyncRoot)
            {
                if (call.IsActive)
                {
                    call.Status = CallStatus.Ended;
                    call.UpdatedAt = now;
                }
            }
            return false;
        }
        return call.Contains(caller.Id) || call.Contains(callee.Id);
    });
    if (busy) return Results.Conflict(new { error = "Caller or callee is busy." });

    var id = Guid.NewGuid();
    var call = new CallSession
    {
        Id = id,
        TenantId = caller.TenantId,
        CallerId = caller.Id,
        CalleeId = callee.Id,
        RoomName = $"call-{id:N}"
    };
    calls[id] = call;
    await hub.Clients.Group(CallHub.Group(callee.Id)).SendAsync("CallUpdated", call.ToView());
    return Results.Created($"/api/calls/{id}", call.ToView());
});

app.MapGet("/api/calls/active", (
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    var active = calls.Values
        .Where(call => call.TenantId == current.TenantId && call.Contains(current.Id) && call.IsActive)
        .OrderByDescending(call => call.CreatedAt)
        .FirstOrDefault();
    return active is null ? Results.NoContent() : Results.Ok(active.ToView());
});

app.MapGet("/api/calls/{id:guid}", (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();
    return Results.Ok(call.ToView());
});

app.MapPost("/api/calls/{id:guid}/accept", async (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IHubContext<CallHub> hub) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || call.CalleeId != current.Id)
        return Results.NotFound();
    lock (call.SyncRoot)
    {
        if (call.Status != CallStatus.Ringing)
            return Results.Conflict(new { error = "Call is no longer ringing.", status = call.Status.ToString() });
        call.Status = CallStatus.Accepted;
        call.AcceptedBy = current.Id;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    await NotifyParticipants(hub, call);
    return Results.Ok(call.ToView());
});

app.MapPost("/api/calls/{id:guid}/reject", Transition(CallStatus.Rejected, callerOnly: false, calleeOnly: true));
app.MapPost("/api/calls/{id:guid}/cancel", Transition(CallStatus.Cancelled, callerOnly: true, calleeOnly: false));

app.MapPost("/api/calls/{id:guid}/end", async (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IHubContext<CallHub> hub,
    LiveKitEgressService egress,
    CancellationToken cancellationToken) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();

    string? egressId;
    lock (call.SyncRoot)
    {
        if (call.Status != CallStatus.Accepted)
            return Results.Conflict(new { error = "Invalid call transition.", status = call.Status.ToString() });
        call.Status = CallStatus.Ended;
        call.UpdatedAt = DateTimeOffset.UtcNow;
        egressId = call.RecordingStatus == "Recording" ? call.RecordingEgressId : null;
        if (egressId is not null) call.RecordingStatus = "Stopping";
    }

    await NotifyParticipants(hub, call);
    if (egressId is not null)
    {
        try
        {
            await egress.StopRecordingAsync(egressId, call.RecordingFileName!, cancellationToken);
            lock (call.SyncRoot) call.RecordingStatus = "Complete";
        }
        catch
        {
            lock (call.SyncRoot) call.RecordingStatus = "Failed";
        }
        call.UpdatedAt = DateTimeOffset.UtcNow;
        await NotifyParticipants(hub, call);
    }
    return Results.Ok(call.ToView());
});

app.MapPost("/api/calls/{id:guid}/token", (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitTokenService tokens) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();
    lock (call.SyncRoot)
    {
        if (call.Status != CallStatus.Accepted)
            return Results.Conflict(new { error = "Media token is available only after accept." });
    }
    var (token, expiresAt) = tokens.CreateJoinToken(current, call.RoomName, TimeSpan.FromMinutes(5));
    return Results.Ok(new TokenResponse(LiveKitWebSocketUrl(request), token, expiresAt));
});

app.MapPost("/api/calls/{id:guid}/recording/start", async (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitEgressService egress,
    IHubContext<CallHub> hub,
    CancellationToken cancellationToken) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();

    var fileName = $"call-{call.Id:N}-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.mp4";
    lock (call.SyncRoot)
    {
        if (call.Status != CallStatus.Accepted)
            return Results.Conflict(new { error = "Recording is available only during an accepted call." });
        if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
            return Results.Conflict(new { error = "This call is already being recorded." });
        call.RecordingStatus = "Starting";
        call.RecordingFileName = fileName;
        call.RecordingEgressId = null;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    await NotifyParticipants(hub, call);

    try
    {
        var result = await egress.StartRoomRecordingAsync(call.RoomName, fileName, cancellationToken);
        lock (call.SyncRoot)
        {
            call.RecordingEgressId = result.EgressId;
            call.RecordingStatus = "Recording";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await NotifyParticipants(hub, call);
        return Results.Ok(call.ToView());
    }
    catch (Exception ex)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Failed";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await NotifyParticipants(hub, call);
        return Results.Json(new { error = $"Không thể bắt đầu ghi hình: {ex.Message}" }, statusCode: 503);
    }
});

app.MapPost("/api/calls/{id:guid}/recording/stop", async (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitEgressService egress,
    IHubContext<CallHub> hub,
    CancellationToken cancellationToken) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();

    string egressId;
    lock (call.SyncRoot)
    {
        if (call.RecordingStatus != "Recording" || string.IsNullOrWhiteSpace(call.RecordingEgressId))
            return Results.Conflict(new { error = "This call is not being recorded." });
        egressId = call.RecordingEgressId;
        call.RecordingStatus = "Stopping";
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    await NotifyParticipants(hub, call);

    try
    {
        await egress.StopRecordingAsync(egressId, call.RecordingFileName!, cancellationToken);
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Complete";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await NotifyParticipants(hub, call);
        return Results.Ok(call.ToView());
    }
    catch (Exception ex)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Failed";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await NotifyParticipants(hub, call);
        return Results.Json(new { error = $"Không thể dừng ghi hình: {ex.Message}" }, statusCode: 503);
    }
});

app.MapGet("/api/calls/{id:guid}/recording/file", (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IConfiguration configuration) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();
    if (call.RecordingStatus != "Complete" || string.IsNullOrWhiteSpace(call.RecordingFileName))
        return Results.Conflict(new { error = "Recording is not ready." });

    var root = configuration["RECORDINGS_PATH"] ?? "/recordings";
    var path = Path.Combine(root, Path.GetFileName(call.RecordingFileName));
    return File.Exists(path)
        ? Results.File(path, "video/mp4", call.RecordingFileName, enableRangeProcessing: true)
        : Results.NotFound(new { error = "Recording file was not found." });
});

app.MapPost("/api/calls/{id:guid}/quality/samples", async (
    Guid id,
    HttpRequest request,
    QualitySampleBatchRequest batch,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallQualityStore qualityStore,
    CancellationToken cancellationToken) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();
    if (call.Status is not (CallStatus.Accepted or CallStatus.Ended))
        return Results.Conflict(new { error = "Quality samples are accepted only for connected calls." });
    if (string.IsNullOrWhiteSpace(batch.ClientSessionId) || batch.ClientSessionId.Length > 120)
        return Results.BadRequest(new { error = "Invalid client session id." });
    if (batch.Samples.Count is < 1 or > 50)
        return Results.BadRequest(new { error = "A quality batch must contain 1 to 50 samples." });

    var oldestAllowed = call.CreatedAt.AddMinutes(-1);
    var newestAllowed = DateTimeOffset.UtcNow.AddMinutes(2);
    if (batch.Samples.Any(sample => sample.Timestamp < oldestAllowed || sample.Timestamp > newestAllowed))
        return Results.BadRequest(new { error = "A quality sample contains an invalid timestamp." });

    await qualityStore.AppendAsync(call, current, batch, cancellationToken);
    return Results.Accepted(value: new { stored = batch.Samples.Count });
});

app.MapGet("/api/calls/{id:guid}/quality/summary", async (
    Guid id,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallQualityStore qualityStore,
    CancellationToken cancellationToken) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();
    return Results.Ok(await qualityStore.BuildReportAsync(id, cancellationToken));
});

app.MapGet("/api/calls/{id:guid}/quality/export", async (
    Guid id,
    string? format,
    HttpRequest request,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallQualityStore qualityStore,
    CancellationToken cancellationToken) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();

    var samples = await qualityStore.ReadAsync(id, cancellationToken);
    if (samples.Count == 0) return Results.NotFound(new { error = "No quality samples have been stored." });
    if (string.Equals(format, "csv", StringComparison.OrdinalIgnoreCase))
    {
        var csv = CallQualityStore.ToCsv(samples);
        return Results.File(
            System.Text.Encoding.UTF8.GetBytes(csv),
            "text/csv; charset=utf-8",
            $"call-{id:N}-quality.csv");
    }

    var report = await qualityStore.BuildReportAsync(id, cancellationToken);
    var payload = System.Text.Json.JsonSerializer.SerializeToUtf8Bytes(
        new { report, samples },
        new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web)
        {
            WriteIndented = true
        });
    return Results.File(payload, "application/json", $"call-{id:N}-quality.json");
});

app.MapHub<CallHub>("/hubs/calls");
app.Run();

static TestIdentity? CurrentIdentity(HttpRequest request, IdentityRegistry identities) =>
    identities.Find(request.Headers["X-User-Id"].FirstOrDefault() ?? request.Query["userId"].FirstOrDefault());

static Func<Guid, HttpRequest, IdentityRegistry, ConcurrentDictionary<Guid, CallSession>, IHubContext<CallHub>, Task<IResult>> Transition(
    CallStatus target,
    bool callerOnly,
    bool calleeOnly) => async (id, request, identities, calls, hub) =>
{
    var current = CurrentIdentity(request, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || call.TenantId != current.TenantId || !call.Contains(current.Id))
        return Results.NotFound();
    if (callerOnly && call.CallerId != current.Id || calleeOnly && call.CalleeId != current.Id)
        return Results.StatusCode(403);
    lock (call.SyncRoot)
    {
        var valid = target switch
        {
            CallStatus.Rejected or CallStatus.Cancelled => call.Status == CallStatus.Ringing,
            CallStatus.Ended => call.Status == CallStatus.Accepted,
            _ => false
        };
        if (!valid)
            return Results.Conflict(new { error = "Invalid call transition.", status = call.Status.ToString() });
        call.Status = target;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    await NotifyParticipants(hub, call);
    return Results.Ok(call.ToView());
};

static Task NotifyParticipants(IHubContext<CallHub> hub, CallSession call) => Task.WhenAll(
    hub.Clients.Group(CallHub.Group(call.CallerId)).SendAsync("CallUpdated", call.ToView()),
    hub.Clients.Group(CallHub.Group(call.CalleeId)).SendAsync("CallUpdated", call.ToView()));

static string LiveKitWebSocketUrl(HttpRequest request)
{
    var forwardedProto = request.Headers["X-Forwarded-Proto"].FirstOrDefault();
    var scheme = string.Equals(forwardedProto, "https", StringComparison.OrdinalIgnoreCase) || request.IsHttps
        ? "wss"
        : "ws";
    var forwardedHost = request.Headers["X-Forwarded-Host"].FirstOrDefault();
    var host = string.IsNullOrWhiteSpace(forwardedHost) ? request.Host.Value : forwardedHost;
    return $"{scheme}://{host}";
}
