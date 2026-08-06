using System.Collections.Concurrent;
using System.Security.Claims;
using LiveKitPoc.Api;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddCors(options => options.AddDefaultPolicy(policy => policy
    .SetIsOriginAllowed(_ => true)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

builder.Services.AddSingleton<AuthTokenService>();
builder.Services.AddSingleton<IdentityRegistry>();
builder.Services.AddSingleton<PresenceRegistry>();
builder.Services.AddSingleton<LiveKitTokenService>();
builder.Services.AddSingleton<CallQualityStore>();
builder.Services.AddSingleton<ConcurrentDictionary<Guid, CallSession>>();
builder.Services.AddHttpClient<LiveKitEgressService>();
builder.Services.AddSignalR();

var authTokens = new AuthTokenService(builder.Configuration);
builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = authTokens.ValidationParameters();
        // SignalR cannot set Authorization header easily from browser — token via query.
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                // SignalR + sendBeacon cannot always set Authorization header.
                var accessToken = context.Request.Query["access_token"].FirstOrDefault();
                if (!string.IsNullOrEmpty(accessToken))
                    context.Token = accessToken;
                return Task.CompletedTask;
            }
        };
    });
builder.Services.AddAuthorization();

var app = builder.Build();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

// ---- Auth (real-world shape: password verify → JWT access token) ----
// Clinic membership is never accepted from the client; it is bound at login.
app.MapGet("/api/auth/accounts", (IdentityRegistry registry) =>
    // Login picker: real demo clinics only (not synthetic Lxx load users).
    Results.Ok(registry.Directory(includeLoadUsers: false).Select(ToUserDto)));

app.MapPost("/api/auth/login", (
    LoginRequest body,
    IdentityRegistry identities,
    AuthTokenService tokens) =>
{
    if (!identities.TryAuthenticate(body.UserId, body.Password, out var user) || user is null)
        return Results.Json(new { error = "Sai tài khoản hoặc mật khẩu." }, statusCode: 401);

    var (accessToken, expiresAt) = tokens.CreateAccessToken(user);
    return Results.Ok(new LoginResponse(accessToken, expiresAt, ToUserDto(user)));
});

app.MapGet("/api/auth/me", (ClaimsPrincipal principal, IdentityRegistry identities) =>
{
    var user = ClinicAuthorization.CurrentUser(principal, identities);
    return user is null
        ? Results.Unauthorized()
        : Results.Ok(ToUserDto(user));
}).RequireAuthorization();

app.MapGet("/api/identities", (ClaimsPrincipal principal, IdentityRegistry registry) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, registry);
    if (current is null) return Results.Unauthorized();
    // Directory is always scoped to the authenticated principal's clinic.
    // Client cannot pass clinicId to broaden the list.
    var peers = registry.DirectoryForClinic(current.ClinicId, includeLoadUsers: false)
        .Select(ToUserDto);
    return Results.Ok(peers);
}).RequireAuthorization();

app.MapGet("/api/presence", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    PresenceRegistry presence) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    // Clinic comes from principal only — ignore any query clinicId if present.
    return Results.Ok(presence.SnapshotForClinic(identities, current.ClinicId));
}).RequireAuthorization();

app.MapPost("/api/calls", async (
    ClaimsPrincipal principal,
    CreateCallRequest body,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IHubContext<CallHub> hub) =>
{
    var caller = ClinicAuthorization.CurrentUser(principal, identities);
    if (caller is null) return Results.Unauthorized();
    var callee = identities.Find(body.CalleeId);
    if (callee is null) return Results.BadRequest(new { error = "Unknown callee." });
    if (caller.Id == callee.Id) return Results.BadRequest(new { error = "Self-call is not allowed." });
    // Cross-clinic create is forbidden. Clinic is server-owned on both identities.
    if (!ClinicAuthorization.SameClinic(caller, callee))
        return Results.Json(new { error = "Không thể gọi user phòng khám / clinic khác." }, statusCode: 403);

    var now = DateTimeOffset.UtcNow;
    var busy = calls.Values.Any(call =>
    {
        if (!call.IsActive) return false;
        // Only auto-expire abandoned ringing invites. Accepted media calls stay busy
        // until hangup (long clinical calls must not be killed by a 2-minute UpdatedAt scan).
        if (call.Status == CallStatus.Ringing && now - call.UpdatedAt > TimeSpan.FromSeconds(45))
        {
            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Ringing)
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
        ClinicId = caller.ClinicId,
        CallerId = caller.Id,
        CalleeId = callee.Id,
        RoomName = CallSession.BuildRoomName(caller.ClinicId, id)
    };
    calls[id] = call;
    await hub.Clients.Group(CallHub.Group(call.ClinicId, callee.Id)).SendAsync("CallUpdated", call.ToView());
    return Results.Created($"/api/calls/{id}", call.ToView());
}).RequireAuthorization();

app.MapGet("/api/calls/active", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var active = calls.Values
        .Where(call => call.BelongsToClinic(current.ClinicId) && call.Contains(current.Id) && call.IsActive)
        .OrderByDescending(call => call.CreatedAt)
        .FirstOrDefault();
    return active is null ? Results.NoContent() : Results.Ok(active.ToView());
}).RequireAuthorization();

app.MapGet("/api/calls/{id:guid}", (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    // Cross-clinic or non-participant → 404 (hide existence).
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    return call is null ? Results.NotFound() : Results.Ok(call.ToView());
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/accept", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IHubContext<CallHub> hub) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCallAs(calls, id, current, requireCallee: true);
    if (call is null) return Results.NotFound();
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
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/reject", Transition(CallStatus.Rejected, callerOnly: false, calleeOnly: true))
    .RequireAuthorization();
app.MapPost("/api/calls/{id:guid}/cancel", Transition(CallStatus.Cancelled, callerOnly: true, calleeOnly: false))
    .RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/end", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IHubContext<CallHub> hub,
    LiveKitEgressService egress,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();

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
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/token", (
    Guid id,
    HttpRequest request,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitTokenService tokens) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    lock (call.SyncRoot)
    {
        if (call.Status != CallStatus.Accepted)
            return Results.Conflict(new { error = "Media token is available only after accept." });
        // Room name is backend-owned; clients never choose the room.
    }
    // Long enough for 15–30 min clinical demos; previously 5 min cut media mid-call.
    var mediaTtlMinutes = int.TryParse(
        Environment.GetEnvironmentVariable("LIVEKIT_JOIN_TOKEN_MINUTES"), out var ttl)
        ? Math.Clamp(ttl, 5, 180)
        : 60;
    var (token, expiresAt) = tokens.CreateJoinToken(current, call.RoomName, TimeSpan.FromMinutes(mediaTtlMinutes));
    return Results.Ok(new TokenResponse(LiveKitWebSocketUrl(request), token, expiresAt));
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/recording/start", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitEgressService egress,
    IHubContext<CallHub> hub,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();

    // Logical clinic namespace in the filename; physical path stays under RECORDINGS_PATH
    // with server-side resolution only (no client path input). Nested dirs remain debt.
    var fileName = $"clinic-{call.ClinicId}-call-{call.Id:N}-{DateTimeOffset.UtcNow:yyyyMMdd-HHmmss}.mp4";
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
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/recording/stop", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitEgressService egress,
    IHubContext<CallHub> hub,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();

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
}).RequireAuthorization();

app.MapGet("/api/calls/{id:guid}/recording/file", (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IConfiguration configuration) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    if (call.RecordingStatus != "Complete" || string.IsNullOrWhiteSpace(call.RecordingFileName))
        return Results.Conflict(new { error = "Recording is not ready." });

    // Path is resolved server-side from authorized metadata only.
    // Clients never supply a filesystem path. GetFileName prevents path traversal.
    var root = configuration["RECORDINGS_PATH"] ?? "/recordings";
    var path = Path.Combine(root, Path.GetFileName(call.RecordingFileName));
    return File.Exists(path)
        ? Results.File(path, "video/mp4", call.RecordingFileName, enableRangeProcessing: true)
        : Results.NotFound(new { error = "Recording file was not found." });
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/quality/samples", async (
    Guid id,
    ClaimsPrincipal principal,
    QualitySampleBatchRequest batch,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallQualityStore qualityStore,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
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
}).RequireAuthorization();

app.MapGet("/api/calls/{id:guid}/quality/summary", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallQualityStore qualityStore,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    return Results.Ok(await qualityStore.BuildReportAsync(id, cancellationToken));
}).RequireAuthorization();

app.MapGet("/api/calls/{id:guid}/quality/export", async (
    Guid id,
    string? format,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallQualityStore qualityStore,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();

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
}).RequireAuthorization();

app.MapHub<CallHub>("/hubs/calls").RequireAuthorization();
app.Run();

static AuthUserDto ToUserDto(TestIdentity user) =>
    new(user.Id, user.ClinicId, user.DisplayName);

static Func<Guid, ClaimsPrincipal, IdentityRegistry, ConcurrentDictionary<Guid, CallSession>, IHubContext<CallHub>, Task<IResult>> Transition(
    CallStatus target,
    bool callerOnly,
    bool calleeOnly) => async (id, principal, identities, calls, hub) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
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
    hub.Clients.Group(CallHub.Group(call.ClinicId, call.CallerId)).SendAsync("CallUpdated", call.ToView()),
    hub.Clients.Group(CallHub.Group(call.ClinicId, call.CalleeId)).SendAsync("CallUpdated", call.ToView()));

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

// DTOs — ClinicId is canonical; TenantId is a JSON compatibility alias for older SPA builds.
file sealed record LoginRequest(string UserId, string Password);
file sealed record AuthUserDto(string Id, string ClinicId, string DisplayName)
{
    public string TenantId => ClinicId;
}
file sealed record LoginResponse(string AccessToken, DateTimeOffset ExpiresAt, AuthUserDto User);
