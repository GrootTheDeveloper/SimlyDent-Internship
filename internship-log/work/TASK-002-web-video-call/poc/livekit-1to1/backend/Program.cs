using System.Collections.Concurrent;
using System.Security.Claims;
using LiveKitPoc.Api;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

// Register embed site registry early so CORS can use allowed origins union.
builder.Services.AddSingleton<ClinicSiteRegistry>();
builder.Services.AddSingleton<EmbedAuthTokenService>();
builder.Services.AddSingleton<EmbedRateLimiter>();

var siteRegistryForCors = new ClinicSiteRegistry(builder.Configuration);
var embedOrigins = siteRegistryForCors.AllAllowedOrigins
    .ToHashSet(StringComparer.OrdinalIgnoreCase);

builder.Services.AddCors(options =>
{
    // Staff SPA / tunnel: keep permissive for PoC (documented debt).
    options.AddDefaultPolicy(policy => policy
        .SetIsOriginAllowed(_ => true)
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials());

    // Embed preflight: union of registered clinic website origins only.
    options.AddPolicy("EmbedCors", policy => policy
        .SetIsOriginAllowed(origin =>
            !string.IsNullOrEmpty(origin) && embedOrigins.Contains(origin))
        .AllowAnyHeader()
        .AllowAnyMethod()
        .AllowCredentials());
});

builder.Services.AddSingleton<AuthTokenService>();
builder.Services.AddSingleton<IdentityRegistry>();
builder.Services.AddSingleton<AgentRegistry>();
builder.Services.AddSingleton<LiveKitTokenService>();
builder.Services.AddSingleton<CallQualityStore>();
builder.Services.AddSingleton<ConcurrentDictionary<Guid, CallSession>>();
builder.Services.AddSingleton<CallDispatcher>();
builder.Services.AddHostedService<RoutingBackgroundService>();
builder.Services.AddHttpClient<LiveKitEgressService>();
builder.Services.AddSignalR();

var authTokens = new AuthTokenService(builder.Configuration);
var embedTokens = new EmbedAuthTokenService(
    builder.Configuration,
    LoggerFactory.Create(b => b.AddConsole()).CreateLogger<EmbedAuthTokenService>());

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(JwtBearerDefaults.AuthenticationScheme, options =>
    {
        // Staff JWT (existing SPA / SignalR / smoke tests) — scheme unchanged.
        options.TokenValidationParameters = authTokens.ValidationParameters();
        options.Events = new JwtBearerEvents
        {
            OnMessageReceived = context =>
            {
                var accessToken = context.Request.Query["access_token"].FirstOrDefault();
                if (!string.IsNullOrEmpty(accessToken))
                    context.Token = accessToken;
                return Task.CompletedTask;
            }
        };
    })
    .AddJwtBearer(EmbedAuthTokenService.AuthenticationScheme, options =>
    {
        options.TokenValidationParameters = embedTokens.ValidationParameters();
        options.MapInboundClaims = false;
    });
builder.Services.AddAuthorization(options =>
{
    // Embed call API: EmbedBearer only (staff JWT audience/secret will not match).
    options.AddPolicy("EmbedVisitor", policy =>
        policy.AddAuthenticationSchemes(EmbedAuthTokenService.AuthenticationScheme)
            .RequireAuthenticatedUser()
            .RequireClaim(EmbedAuthTokenService.ClaimTokenUse, EmbedAuthTokenService.TokenUseEmbed));
});

var app = builder.Build();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

// ---- Embed bootstrap (anonymous) — Phase 2 PR-A ----
app.MapPost("/embed/session", (
    HttpContext http,
    EmbedSessionRequest body,
    ClinicSiteRegistry sites,
    EmbedAuthTokenService embedAuth,
    EmbedRateLimiter rateLimiter) =>
{
    var origin = http.Request.Headers.Origin.FirstOrDefault()
                 ?? http.Request.Headers["Origin"].FirstOrDefault();

    if (string.IsNullOrWhiteSpace(body.SiteKey))
        return Results.BadRequest(new { error = "siteKey is required." });

    var site = sites.FindBySiteKey(body.SiteKey);
    if (site is null)
        return Results.NotFound(new { error = "Unknown site key." });
    if (!site.Enabled)
        return Results.Json(new { error = "Site is disabled." }, statusCode: 403);

    // Exact Origin allowlist for THIS site_key (not union-only).
    if (!OriginMatcher.IsAllowed(origin, site.AllowedOrigins))
        return Results.Json(new { error = "Origin is not allowed for this site key." }, statusCode: 403);

    var clientIp = EmbedRateLimiter.GetClientIp(http);
    var rateKey = $"session:{site.SiteKey}:{clientIp}";
    if (!rateLimiter.TryAcquire(rateKey))
        return Results.Json(new { error = "Rate limit exceeded." }, statusCode: 429);

    var (token, expiresAt, sessionId) = embedAuth.CreateSessionToken(site);
    return Results.Ok(new EmbedSessionResponse(
        token,
        expiresAt,
        sessionId,
        site.ClinicId,
        site.SiteId,
        site.SiteKey));
}).RequireCors("EmbedCors");

// ---- Embed calls (visitor session) — Phase 2 PR-B ----
// Auth: EmbedBearer only. Ownership: session VisitorId == call.CallerId + same clinic.
// DTO: EmbedCallView (no room/recording/staff internals). Media token only after Accept.

app.MapPost("/embed/calls", async (
    HttpContext http,
    ClaimsPrincipal principal,
    CallDispatcher dispatcher,
    EmbedRateLimiter rateLimiter) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();

    var clientIp = EmbedRateLimiter.GetClientIp(http);
    var rateKey = $"calls:{session.SessionId}:{clientIp}";
    if (!rateLimiter.TryAcquire(rateKey))
        return Results.Json(new { error = "Rate limit exceeded." }, statusCode: 429);

    var actor = CallActor.FromEmbed(session);
    var call = await dispatcher.EnqueueAsync(actor.AsIdentity());
    ClinicAuthorization.TouchVisitorSeen(call);

    if (call.Status == CallStatus.Closed)
        return Results.Json(
            new { error = "Clinic is closed.", call = EmbedCallView.From(call) },
            statusCode: 403);

    return Results.Created($"/embed/calls/{call.Id}", EmbedCallView.From(call));
}).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

app.MapGet("/embed/calls/{id:guid}", (
    Guid id,
    ClaimsPrincipal principal,
    ConcurrentDictionary<Guid, CallSession> calls) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();

    var call = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
    if (call is null) return Results.NotFound();

    // Poll = visitor heartbeat for stale recovery.
    ClinicAuthorization.TouchVisitorSeen(call);
    return Results.Ok(EmbedCallView.From(call));
}).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

app.MapPost("/embed/calls/{id:guid}/cancel", async (
    Guid id,
    ClaimsPrincipal principal,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();

    // Ownership gate first → 404 for cross-session / cross-clinic (no enumeration).
    var owned = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
    if (owned is null) return Results.NotFound();

    ClinicAuthorization.TouchVisitorSeen(owned);
    var result = await dispatcher.TryCancelAsync(id, CallActor.FromEmbed(session).AsIdentity());
    return result.Kind switch
    {
        CallTransitionKind.Ok => Results.Ok(EmbedCallView.From(result.Call!)),
        CallTransitionKind.NotFound => Results.NotFound(),
        CallTransitionKind.Forbidden => Results.StatusCode(403),
        _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
    };
}).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

app.MapPost("/embed/calls/{id:guid}/end", async (
    Guid id,
    ClaimsPrincipal principal,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();

    var owned = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
    if (owned is null) return Results.NotFound();

    ClinicAuthorization.TouchVisitorSeen(owned);
    var result = await dispatcher.TryEndAsync(id, CallActor.FromEmbed(session).AsIdentity());
    return result.Kind switch
    {
        CallTransitionKind.Ok => Results.Ok(EmbedCallView.From(result.Call!)),
        CallTransitionKind.NotFound => Results.NotFound(),
        CallTransitionKind.Forbidden => Results.StatusCode(403),
        _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
    };
}).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

app.MapPost("/embed/calls/{id:guid}/token", (
    Guid id,
    HttpRequest request,
    ClaimsPrincipal principal,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitTokenService tokens) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();

    var call = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
    if (call is null) return Results.NotFound();

    ClinicAuthorization.TouchVisitorSeen(call);

    string roomName;
    lock (call.SyncRoot)
    {
        if (call.Status != CallStatus.Accepted)
            return Results.Conflict(new { error = "Media token is available only after accept." });
        roomName = call.RoomName;
    }

    // Room is server-chosen; widget never selects room. LiveKit JWT embeds room claim.
    var mediaTtlMinutes = int.TryParse(
        Environment.GetEnvironmentVariable("LIVEKIT_JOIN_TOKEN_MINUTES"), out var ttl)
        ? Math.Clamp(ttl, 5, 180)
        : 60;
    var identity = CallActor.FromEmbed(session).AsIdentity();
    var (token, expiresAt) = tokens.CreateJoinToken(identity, roomName, TimeSpan.FromMinutes(mediaTtlMinutes));
    return Results.Ok(new TokenResponse(LiveKitWebSocketUrl(request), token, expiresAt));
}).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

// ---- Auth ----
app.MapGet("/api/auth/accounts", (IdentityRegistry registry) =>
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
    var denied = ClinicAuthorization.RequireStaff(current);
    if (denied is not null) return denied;
    var peers = registry.DirectoryForClinic(current!.ClinicId, includeLoadUsers: false)
        .Select(ToUserDto);
    return Results.Ok(peers);
}).RequireAuthorization();

app.MapGet("/api/presence", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    AgentRegistry agents) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaff(current);
    if (denied is not null) return denied;
    return Results.Ok(agents.SnapshotForClinic(identities, current!.ClinicId));
}).RequireAuthorization();

app.MapGet("/api/agents", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    AgentRegistry agents) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaff(current);
    if (denied is not null) return denied;
    return Results.Ok(agents.SnapshotForClinic(identities, current!.ClinicId));
}).RequireAuthorization();

app.MapGet("/api/queue", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaff(current);
    if (denied is not null) return denied;
    return Results.Ok(dispatcher.QueueSnapshot(current!.ClinicId));
}).RequireAuthorization();

app.MapPost("/api/agents/heartbeat", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    AgentRegistry agents) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaff(current);
    if (denied is not null) return denied;
    return Results.Ok(agents.Heartbeat(current!.ClinicId, current.Id));
}).RequireAuthorization();

/// <summary>Staff ready for auto-dispatch (SignalR connect also does this).</summary>
app.MapPost("/api/agents/ready", async (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    AgentRegistry agents,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaff(current);
    if (denied is not null) return denied;
    var view = agents.MarkReady(current!.ClinicId, current.Id);
    await dispatcher.BroadcastAgentsAsync(current.ClinicId);
    await dispatcher.TryDispatchClinicAsync(current.ClinicId);
    return Results.Ok(view);
}).RequireAuthorization();

// ---- Queue path (visitor auto-dispatch) ----
app.MapPost("/api/queue/calls", async (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    CallDispatcher dispatcher) =>
{
    var visitor = ClinicAuthorization.CurrentUser(principal, identities);
    if (visitor is null) return Results.Unauthorized();
    // Phase 1: demo visitors VA/VB. Staff may also enqueue for manual testing.
    var call = await dispatcher.EnqueueAsync(visitor);
    if (call.Status == CallStatus.Closed)
        return Results.Json(new { error = "Clinic is closed.", call = call.ToView() }, statusCode: 403);
    return Results.Created($"/api/calls/{call.Id}", call.ToView());
}).RequireAuthorization();

// ---- Direct staff→staff call (TASK-002 path, still supported) ----
app.MapPost("/api/calls", async (
    ClaimsPrincipal principal,
    CreateCallRequest body,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher,
    AgentRegistry agents) =>
{
    var caller = ClinicAuthorization.CurrentUser(principal, identities);
    if (caller is null) return Results.Unauthorized();
    if (caller.Role == IdentityRoles.Visitor)
        return Results.Json(new { error = "Visitors must use POST /api/queue/calls." }, statusCode: 403);

    var callee = identities.Find(body.CalleeId);
    if (callee is null) return Results.BadRequest(new { error = "Unknown callee." });
    if (callee.Role != IdentityRoles.Staff)
        return Results.BadRequest(new { error = "Direct calls require a staff callee." });
    if (caller.Id == callee.Id) return Results.BadRequest(new { error = "Self-call is not allowed." });
    if (!ClinicAuthorization.SameClinic(caller, callee))
        return Results.Json(new { error = "Không thể gọi user phòng khám / clinic khác." }, statusCode: 403);

    var now = DateTimeOffset.UtcNow;
    var busy = calls.Values.Any(call =>
    {
        if (!call.IsActive) return false;
        if (call.Status == CallStatus.Ringing && call.Origin == CallOrigin.Direct
            && now - call.UpdatedAt > TimeSpan.FromSeconds(45))
        {
            lock (call.SyncRoot)
            {
                if (call.Status == CallStatus.Ringing)
                {
                    call.Status = CallStatus.Ended;
                    call.UpdatedAt = now;
                }
            }
            agents.TryRelease(call.ClinicId, call.CalleeId, call.Id, force: true);
            agents.TryRelease(call.ClinicId, call.CallerId, call.Id, force: true);
            return false;
        }
        return call.Contains(caller.Id) || call.Contains(callee.Id);
    });
    if (busy) return Results.Conflict(new { error = "Caller or callee is busy." });

    if (agents.IsBusy(callee.ClinicId, callee.Id))
        return Results.Conflict(new { error = "Callee is busy." });

    var id = Guid.NewGuid();
    var session = new CallSession
    {
        Id = id,
        ClinicId = caller.ClinicId,
        CallerId = caller.Id,
        CalleeId = callee.Id,
        Origin = CallOrigin.Direct,
        RoomName = CallSession.BuildRoomName(caller.ClinicId, id)
    };
    if (!dispatcher.TryAssignDirect(session, callee.Id))
        return Results.Conflict(new { error = "Callee is not available (busy)." });

    calls[id] = session;
    await dispatcher.NotifyCallAsync(session);
    await dispatcher.BroadcastAgentsAsync(session.ClinicId);
    return Results.Created($"/api/calls/{id}", session.ToView());
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
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    return call is null ? Results.NotFound() : Results.Ok(call.ToView());
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/accept", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    if (!ClinicAuthorization.IsStaff(current))
        return Results.StatusCode(403);

    var result = await dispatcher.TryAcceptAsync(id, current);
    return result.Kind switch
    {
        CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
        CallTransitionKind.NotFound => Results.NotFound(),
        CallTransitionKind.Forbidden => Results.StatusCode(403),
        _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
    };
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/reject", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    if (!ClinicAuthorization.IsStaff(current))
        return Results.StatusCode(403);

    var result = await dispatcher.TryRejectAsync(id, current);
    return result.Kind switch
    {
        CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
        CallTransitionKind.NotFound => Results.NotFound(),
        CallTransitionKind.Forbidden => Results.StatusCode(403),
        _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
    };
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/cancel", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();

    var result = await dispatcher.TryCancelAsync(id, current);
    return result.Kind switch
    {
        CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
        CallTransitionKind.NotFound => Results.NotFound(),
        CallTransitionKind.Forbidden => Results.StatusCode(403),
        _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
    };
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/end", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    CallDispatcher dispatcher,
    LiveKitEgressService egress,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();

    // Capture recording egress under same ownership; transition is atomic in dispatcher.
    string? egressId = null;
    string? recordingFile = null;
    if (calls.TryGetValue(id, out var pre)
        && pre.BelongsToClinic(current.ClinicId)
        && pre.Contains(current.Id))
    {
        lock (pre.SyncRoot)
        {
            if (pre.Status == CallStatus.Accepted && pre.RecordingStatus == "Recording")
            {
                egressId = pre.RecordingEgressId;
                recordingFile = pre.RecordingFileName;
            }
        }
    }

    var result = await dispatcher.TryEndAsync(id, current);
    if (result.Kind == CallTransitionKind.NotFound) return Results.NotFound();
    if (result.Kind == CallTransitionKind.Forbidden) return Results.StatusCode(403);
    if (result.Kind == CallTransitionKind.Conflict)
        return Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() });

    var call = result.Call!;
    if (egressId is not null && recordingFile is not null)
    {
        lock (call.SyncRoot)
        {
            if (call.RecordingStatus is not ("Stopping" or "Complete" or "Failed"))
                call.RecordingStatus = "Stopping";
        }
        try
        {
            await egress.StopRecordingAsync(egressId, recordingFile, cancellationToken);
            lock (call.SyncRoot) call.RecordingStatus = "Complete";
        }
        catch
        {
            lock (call.SyncRoot) call.RecordingStatus = "Failed";
        }
        call.UpdatedAt = DateTimeOffset.UtcNow;
        await dispatcher.NotifyCallAsync(call);
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
    }
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
    CallDispatcher dispatcher,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();

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
    await dispatcher.NotifyCallAsync(call);

    try
    {
        var result = await egress.StartRoomRecordingAsync(call.RoomName, fileName, cancellationToken);
        lock (call.SyncRoot)
        {
            call.RecordingEgressId = result.EgressId;
            call.RecordingStatus = "Recording";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await dispatcher.NotifyCallAsync(call);
        return Results.Ok(call.ToView());
    }
    catch (Exception ex)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Failed";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await dispatcher.NotifyCallAsync(call);
        return Results.Json(new { error = $"Không thể bắt đầu ghi hình: {ex.Message}" }, statusCode: 503);
    }
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/recording/stop", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    LiveKitEgressService egress,
    CallDispatcher dispatcher,
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
    await dispatcher.NotifyCallAsync(call);

    try
    {
        await egress.StopRecordingAsync(egressId, call.RecordingFileName!, cancellationToken);
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Complete";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await dispatcher.NotifyCallAsync(call);
        return Results.Ok(call.ToView());
    }
    catch (Exception ex)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Failed";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await dispatcher.NotifyCallAsync(call);
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
    new(user.Id, user.ClinicId, user.DisplayName, user.Role);

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

file sealed record LoginRequest(string UserId, string Password);
file sealed record AuthUserDto(string Id, string ClinicId, string DisplayName, string Role = IdentityRoles.Staff)
{
    public string TenantId => ClinicId;
}
file sealed record LoginResponse(string AccessToken, DateTimeOffset ExpiresAt, AuthUserDto User);

file sealed record EmbedSessionRequest(string SiteKey);
file sealed record EmbedSessionResponse(
    string AccessToken,
    DateTimeOffset ExpiresAt,
    string SessionId,
    string ClinicId,
    string SiteId,
    string SiteKey);
