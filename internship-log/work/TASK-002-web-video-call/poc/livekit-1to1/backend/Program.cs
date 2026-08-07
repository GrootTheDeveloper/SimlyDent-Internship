using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using LiveKitPoc.Api;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);

// Trust reverse proxy (Caddy) so RemoteIpAddress reflects client — rate limit must not read spoofable XFF alone.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    // Docker/Caddy sits in front; clear defaults so headers are not dropped in compose.
#pragma warning disable CS0618
    options.KnownNetworks.Clear();
#pragma warning restore CS0618
    options.KnownProxies.Clear();
});

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
builder.Services.AddSingleton<RecordingPolicyRegistry>();
builder.Services.AddSingleton<RecordingAuditService>();
builder.Services.AddSingleton<IRecordingStorage>(RecordingStorageFactory.Create);
builder.Services.AddSingleton<IRecordingCatalog>(RecordingCatalogFactory.Create);
builder.Services.AddSingleton<IConsultationCatalog>(ConsultationCatalogFactory.Create);
builder.Services.AddSingleton<LiveKitWebhookValidator>();
builder.Services.AddSingleton<RecordingFinalizeService>();
builder.Services.AddSingleton<ConsultationAudioService>();
builder.Services.AddSingleton<DentalClipService>();
builder.Services.AddSingleton<ConsultationMediaLifecycleService>();
builder.Services.AddSingleton<SnapshotService>();
builder.Services.AddSingleton<CallDispatcher>();
builder.Services.AddSingleton<CallEndService>();
builder.Services.AddHostedService<RoutingBackgroundService>();
builder.Services.AddSingleton<RecordingRetentionService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RecordingRetentionService>());
builder.Services.AddSingleton<RecordingReconcileService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<RecordingReconcileService>());
builder.Services.AddHttpClient<LiveKitEgressService>();
builder.Services.AddHttpClient<LiveKitRoomService>();
builder.Services.AddHttpClient(nameof(S3RecordingStorage));
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
app.UseForwardedHeaders();
app.UseCors();
app.UseAuthentication();
app.UseAuthorization();

// Capability fail-fast for S3 modes (Phase C hard rules).
try
{
    RecordingS3Config.ValidateOrThrow(app.Configuration, app.Logger);
}
catch (Exception ex)
{
    app.Logger.LogCritical(ex, "Fatal recording S3 configuration error.");
    throw;
}

// Durable recording catalog schema (no-op for memory backend).
try
{
    var catalog = app.Services.GetRequiredService<IRecordingCatalog>();
    catalog.EnsureSchemaAsync().GetAwaiter().GetResult();
    app.Logger.LogInformation("Recording catalog backend: {Backend}", catalog.BackendName);
}
catch (Exception ex)
{
    app.Logger.LogWarning(ex,
        "Recording catalog schema init failed — start/list may degrade until DB is available.");
}

// Consultation media catalog (additive tables).
try
{
    var mediaCatalog = app.Services.GetRequiredService<IConsultationCatalog>();
    mediaCatalog.EnsureSchemaAsync().GetAwaiter().GetResult();
    app.Logger.LogInformation("Consultation catalog backend: {Backend}", mediaCatalog.BackendName);
}
catch (Exception ex)
{
    app.Logger.LogWarning(ex,
        "Consultation catalog schema init failed — media features may degrade until DB is available.");
}

app.MapConsultationEndpoints();
app.MapMediaEndpoints();

app.MapGet("/health", (IRecordingCatalog catalog, IRecordingStorage storage, IConsultationCatalog mediaCatalog, IConfiguration config) =>
{
    var egressOut = (config["EGRESS_OUTPUT"] ?? "local").Trim().ToLowerInvariant();
    return Results.Ok(new
    {
        status = "ok",
        recordingCatalog = catalog.BackendName,
        consultationCatalog = mediaCatalog.BackendName,
        recordingStorage = storage.BackendName,
        egressOutput = egressOut,
        s3PublicConfigured = !string.IsNullOrWhiteSpace(RecordingS3Config.GetPublicEndpoint(config)),
        supportsPresignedGet = storage.SupportsPresignedGet,
        featureMediaAssets = ConsultationEndpoints.IsMediaFeatureEnabled(config)
    });
});

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
    CallEndService endService,
    CancellationToken cancellationToken) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();

    var owned = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
    if (owned is null) return Results.NotFound();

    ClinicAuthorization.TouchVisitorSeen(owned);
    var result = await endService.EndWithRecordingAsync(
        id, CallActor.FromEmbed(session).AsIdentity(), cancellationToken);
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
    var denied = ClinicAuthorization.RequireStaffOrManager(current);
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
    var denied = ClinicAuthorization.RequireStaffOrManager(current);
    if (denied is not null) return denied;
    return Results.Ok(agents.SnapshotForClinic(identities, current!.ClinicId));
}).RequireAuthorization();

app.MapGet("/api/agents", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    AgentRegistry agents) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaffOrManager(current);
    if (denied is not null) return denied;
    return Results.Ok(agents.SnapshotForClinic(identities, current!.ClinicId));
}).RequireAuthorization();

app.MapGet("/api/queue", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaffOrManager(current);
    if (denied is not null) return denied;
    return Results.Ok(dispatcher.QueueSnapshot(current!.ClinicId));
}).RequireAuthorization();

// ---- Recording policy (Phase 3) ----
app.MapGet("/api/clinics/me/recording-policy", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    RecordingPolicyRegistry policies) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = ClinicAuthorization.RequireStaffOrManager(current);
    if (denied is not null) return denied;
    return Results.Ok(policies.Get(current!.ClinicId).ToView());
}).RequireAuthorization();

/// <summary>
/// Manager library: clinic-scoped recordings from durable catalog (fallback: in-memory calls).
/// Staff → 403. Cross-clinic isolation by principal clinic only.
/// </summary>
app.MapGet("/api/recordings", async (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    IRecordingCatalog catalog,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = RecordingAuthorization.RequireManager(current);
    if (denied is not null) return denied;

    var clinicId = current!.ClinicId;
    var policy = policies.Get(clinicId);

    static string CallerLabel(string? callerId)
    {
        if (string.IsNullOrWhiteSpace(callerId)) return "—";
        if (callerId.StartsWith("visitor:", StringComparison.OrdinalIgnoreCase))
        {
            var raw = callerId["visitor:".Length..].Replace("-", "");
            var code = raw.Length >= 6 ? raw[..6].ToUpperInvariant() : raw.ToUpperInvariant();
            return $"Khách #{code}";
        }
        if (callerId.Length <= 8 && char.IsLetter(callerId[0])) return callerId;
        return callerId;
    }

    // Prefer durable catalog so Manager library survives API restart.
    var catalogRows = await catalog.ListByClinicAsync(clinicId, cancellationToken);
    if (catalogRows.Count > 0 || catalog.BackendName is "postgres")
    {
        var items = catalogRows.Select(r =>
        {
            var uiStatus = RecordingLedgerStatus.ToUiStatus(r.Status);
            var canDownload = RecordingLedgerStatus.IsDownloadable(r.Status)
                              && !string.IsNullOrWhiteSpace(r.StorageKey);
            var canDelete = r.Status is RecordingLedgerStatus.Deleted
                            || (r.Status is RecordingLedgerStatus.Ready or RecordingLedgerStatus.Failed
                                && !string.IsNullOrWhiteSpace(r.StorageKey));
            return new RecordingListItem(
                r.CallId,
                r.Id,
                r.CallerId ?? "",
                CallerLabel(r.CallerId),
                r.AssignedStaffId,
                r.CallStatus ?? "—",
                r.Mode,
                uiStatus,
                r.ConsentStatus ?? "—",
                r.CreatedAt,
                r.UpdatedAt,
                canDownload,
                canDelete);
        }).ToList();
        return Results.Ok(new RecordingListResponse(items, items.Count));
    }

    // Memory catalog empty: fall back to live call sessions (lab without prior starts).
    static bool IsLibraryRow(CallSession c) =>
        c.RecordingStatus is not ("Idle" or "")
        || !string.IsNullOrWhiteSpace(c.RecordingStorageKey)
        || c.RecordingMode != RecordingMode.None;

    var fallback = calls.Values
        .Where(c => c.BelongsToClinic(clinicId) && IsLibraryRow(c))
        .OrderByDescending(c => c.UpdatedAt)
        .Select(c =>
        {
            var view = RecordingAuthorization.BuildView(c, current, policy);
            return new RecordingListItem(
                c.Id,
                c.RecordingId,
                c.CallerId,
                CallerLabel(c.CallerId),
                c.AssignedStaffId ?? c.CalleeId,
                c.Status.ToString(),
                c.RecordingMode.ToString(),
                c.RecordingStatus,
                c.ConsentStatus.ToString(),
                c.CreatedAt,
                c.UpdatedAt,
                view.CanDownload,
                view.CanDelete);
        })
        .ToList();

    return Results.Ok(new RecordingListResponse(fallback, fallback.Count));
}).RequireAuthorization();

app.MapGet("/api/recording/audit", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    RecordingAuditService audit) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = RecordingAuthorization.RequireManager(current);
    if (denied is not null) return denied;
    return Results.Ok(audit.Snapshot(current!.ClinicId));
}).RequireAuthorization();

app.MapPost("/api/admin/recording/retention-run", (
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    RecordingRetentionService retention) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    var denied = RecordingAuthorization.RequireManager(current);
    if (denied is not null) return denied;
    var n = retention.RunOnce();
    return Results.Ok(new { deleted = n });
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
    AgentRegistry agents,
    RecordingPolicyRegistry recordingPolicies) =>
{
    var caller = ClinicAuthorization.CurrentUser(principal, identities);
    if (caller is null) return Results.Unauthorized();
    if (caller.Role == IdentityRoles.Visitor)
        return Results.Json(new { error = "Visitors must use POST /api/queue/calls." }, statusCode: 403);
    // Managers may observe; only Staff place direct calls (or Staff callee).
    if (caller.Role == IdentityRoles.Manager)
        return Results.Json(new { error = "Managers do not place direct media calls in this PoC." }, statusCode: 403);

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
    var policy = recordingPolicies.Get(caller.ClinicId);
    var session = new CallSession
    {
        Id = id,
        ClinicId = caller.ClinicId,
        CallerId = caller.Id,
        CalleeId = callee.Id,
        Origin = CallOrigin.Direct,
        RoomName = CallSession.BuildRoomName(caller.ClinicId, id),
        RecordingMode = policy.DefaultMode
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
    CallDispatcher dispatcher,
    IConsultationCatalog consultationCatalog,
    ConsultationAudioService audioService,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    if (!ClinicAuthorization.IsStaff(current))
        return Results.StatusCode(403);

    var result = await dispatcher.TryAcceptAsync(id, current);
    if (result.Kind == CallTransitionKind.Ok && result.Call is not null)
    {
        var call = result.Call;
        try
        {
            var caller = identities.Find(call.CallerId);
            var staff = identities.Find(call.AssignedStaffId ?? call.CalleeId ?? current.Id);
            var session = await consultationCatalog.EnsureSessionAsync(
                call.Id, call.ClinicId, call.RoomName,
                call.CallerId, caller?.DisplayName ?? call.CallerId,
                staff?.Id ?? current.Id, staff?.DisplayName ?? current.DisplayName,
                initialMediaMode: "Audio", cancellationToken);
            lock (call.SyncRoot) { call.ConsultationSessionId = session.Id; }
            // Best-effort auto audio (consent gate inside)
            await audioService.EnsureAutoAudioStartedAsync(call, cancellationToken);
        }
        catch (Exception ex)
        {
            // Never fail Accept — media is independent of call
            app.Logger.LogWarning(ex, "Consultation session/audio ensure failed on Accept {CallId}", call.Id);
        }
    }
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
    CallEndService endService,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();

    var result = await endService.EndWithRecordingAsync(id, current, cancellationToken);
    return result.Kind switch
    {
        CallTransitionKind.Ok => Results.Ok(result.Call!.ToView()),
        CallTransitionKind.NotFound => Results.NotFound(),
        CallTransitionKind.Forbidden => Results.StatusCode(403),
        _ => Results.Conflict(new { error = result.Error, status = result.Call?.Status.ToString() })
    };
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

// ---- Recording control (Phase 3) — RecordingAuthorization ≠ call participant alone ----
app.MapGet("/api/calls/{id:guid}/recording", (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    if (!calls.TryGetValue(id, out var call) || !call.BelongsToClinic(current.ClinicId))
        return Results.NotFound();
    if (!RecordingAuthorization.CanViewBusinessState(current, call)
        && ClinicAuthorization.GetAuthorizedCall(calls, id, current) is null
        && RecordingAuthorization.GetClinicCallForManager(calls, id, current) is null)
        return Results.NotFound();
    var policy = policies.Get(call.ClinicId);
    return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/recording/mode", (
    Guid id,
    SetRecordingModeRequest body,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    CallDispatcher dispatcher) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    if (!RecordingAuthorization.CanStartStop(current, call))
        return Results.Json(new { error = "Only call staff may set recording mode." }, statusCode: 403);
    if (!Enum.TryParse<RecordingMode>(body.Mode, ignoreCase: true, out var mode))
        return Results.BadRequest(new { error = "Invalid mode. Use None, AudioOnly, or Video." });
    var policy = policies.Get(call.ClinicId);
    if (!policy.IsModeAllowed(mode))
        return Results.Json(new { error = "Mode not allowed by clinic policy." }, statusCode: 403);
    lock (call.SyncRoot)
    {
        if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
            return Results.Conflict(new { error = "Cannot change mode while recording is active." });
        call.RecordingMode = mode;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    _ = dispatcher.NotifyCallAsync(call);
    return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/recording/consent", async (
    Guid id,
    SetConsentRequest body,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    CallDispatcher dispatcher,
    ConsultationAudioService audioService,
    IConsultationCatalog consultationCatalog,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    if (!Enum.TryParse<ConsentStatus>(body.Status, ignoreCase: true, out var consent)
        || consent == ConsentStatus.Pending)
        return Results.BadRequest(new { error = "Status must be Granted or Declined." });
    var policy = policies.Get(call.ClinicId);
    lock (call.SyncRoot)
    {
        call.ConsentStatus = consent;
        call.ConsentActorId = current.Id;
        call.ConsentPolicyVersion = policy.Version;
        call.ConsentGrantedAt = consent == ConsentStatus.Granted ? DateTimeOffset.UtcNow : null;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    audit.Append(call.ClinicId, call.Id, call.RecordingId, current.Id, current.Role,
        consent == ConsentStatus.Granted ? "ConsentGranted" : "ConsentDeclined", "Ok");

    if (consent == ConsentStatus.Granted && call.Status == CallStatus.Accepted)
    {
        try
        {
            if (await consultationCatalog.GetSessionByCallIdAsync(call.Id, cancellationToken) is null)
            {
                var caller = identities.Find(call.CallerId);
                var staff = identities.Find(call.AssignedStaffId ?? call.CalleeId ?? current.Id);
                await consultationCatalog.EnsureSessionAsync(
                    call.Id, call.ClinicId, call.RoomName,
                    call.CallerId, caller?.DisplayName ?? call.CallerId,
                    staff?.Id ?? current.Id, staff?.DisplayName ?? current.DisplayName,
                    "Audio", cancellationToken);
            }
            await audioService.EnsureAutoAudioStartedAsync(call, cancellationToken);
        }
        catch (Exception ex)
        {
            app.Logger.LogWarning(ex, "Auto audio after consent failed for {CallId}", call.Id);
        }
    }

    _ = dispatcher.NotifyCallAsync(call);
    return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
}).RequireAuthorization();

app.MapPost("/api/calls/{id:guid}/recording/start", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    LiveKitEgressService egress,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    CallDispatcher dispatcher,
    RecordingAuditService audit,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    if (!RecordingAuthorization.CanStartStop(current, call))
        return Results.Json(new { error = "Only call staff may start recording." }, statusCode: 403);

    var policy = policies.Get(call.ClinicId);
    RecordingMode mode;
    string fileName;
    string recId;
    string storageKey;
    lock (call.SyncRoot)
    {
        var gate = RecordingAuthorization.ValidateStart(call, policy);
        if (gate is not null)
            return Results.Conflict(new { error = gate });
        mode = call.RecordingMode;
        recId = Guid.NewGuid().ToString("N");
        fileName = $"clinic-{call.ClinicId}-call-{call.Id:N}-{recId}.mp4";
        storageKey = storage.BuildKey(call.ClinicId, call.Id, recId, "mp4");
        call.RecordingStatus = "Starting";
        call.RecordingFileName = fileName;
        call.RecordingId = recId;
        call.RecordingEgressId = null;
        call.RecordingStorageKey = storageKey;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }

    // Durable ledger BEFORE egress starts — survive restart even if StartEgress hangs.
    var retentionUntil = DateTimeOffset.UtcNow.AddDays(policy.RetentionDays);
    try
    {
        await catalog.InsertRequestedAsync(
            recId,
            call.ClinicId,
            call.Id,
            mode.ToString(),
            storageKey,
            "Composite",
            retentionUntil,
            call.CallerId,
            call.AssignedStaffId ?? call.CalleeId,
            call.Status.ToString(),
            call.ConsentStatus.ToString(),
            fileName,
            cancellationToken);
    }
    catch (Exception ex)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Failed";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
            "RecordingStartFailed", "Failed", $"catalog: {ex.Message}");
        await dispatcher.NotifyCallAsync(call);
        return Results.Json(new { error = $"Không thể tạo ledger ghi hình: {ex.Message}", call = call.ToView() },
            statusCode: 503);
    }

    await dispatcher.NotifyCallAsync(call);

    try
    {
        var result = await egress.StartRoomRecordingAsync(
            call.RoomName, fileName, mode, storageKey, cancellationToken);
        lock (call.SyncRoot)
        {
            call.RecordingEgressId = result.EgressId;
            call.RecordingStatus = "Recording";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await catalog.TryMarkRecordingAsync(recId, result.EgressId, cancellationToken);
        audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
            "RecordingStarted", "Ok", mode.ToString());
        await dispatcher.NotifyCallAsync(call);
        return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
    }
    catch (Exception ex)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Failed";
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        // Start never got egress_id — use placeholder correlation empty only if needed
        try { await catalog.TryMarkFailedAsync(recId, "", ex.Message, cancellationToken); }
        catch
        {
            // Requested → Failed requires egress match; allow fail without egress by direct path:
            // Try with empty only works if egress_id null and WHERE egress_id = '' fails.
        }
        // Best-effort: if still Requested without egress, update via failed with any egress after insert
        audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
            "RecordingStartFailed", "Failed", ex.Message);
        await dispatcher.NotifyCallAsync(call);
        // Call remains Accepted — recording failure ≠ call failure.
        return Results.Json(new { error = $"Không thể bắt đầu ghi: {ex.Message}", call = call.ToView() }, statusCode: 503);
    }
}).RequireAuthorization();

/// <summary>
/// Async stop: Finalizing + short StopEgress control call; Ready via webhook/reconcile.
/// Transport errors keep Finalizing (not Failed).
/// </summary>
app.MapPost("/api/calls/{id:guid}/recording/stop", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    LiveKitEgressService egress,
    IRecordingCatalog catalog,
    CallDispatcher dispatcher,
    RecordingAuditService audit,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetAuthorizedCall(calls, id, current);
    if (call is null) return Results.NotFound();
    if (!RecordingAuthorization.CanStartStop(current, call))
        return Results.Json(new { error = "Only call staff may stop recording." }, statusCode: 403);

    var policy = policies.Get(call.ClinicId);
    string egressId;
    string recId;
    lock (call.SyncRoot)
    {
        if (call.RecordingStatus != "Recording" || string.IsNullOrWhiteSpace(call.RecordingEgressId))
            return Results.Conflict(new { error = "This call is not being recorded." });
        egressId = call.RecordingEgressId;
        recId = call.RecordingId ?? Guid.NewGuid().ToString("N");
        call.RecordingStatus = "Stopping";
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }

    try { await catalog.TryMarkFinalizingAsync(recId, egressId, cancellationToken); }
    catch { /* dual-write best-effort */ }
    await dispatcher.NotifyCallAsync(call);

    try
    {
        await egress.RequestStopAsync(egressId, cancellationToken);
        audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
            "RecordingStopRequested", "Ok");
    }
    catch (Exception ex)
    {
        // Transport uncertainty — stay Finalizing; reconcile is authority.
        audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
            "RecordingStopRequested", "TransportError", ex.Message);
    }

    // Return immediately with Stopping/Finalizing — no Materialize / COMPLETE wait.
    return Results.Ok(RecordingAuthorization.BuildView(call, current, policy));
}).RequireAuthorization();

/// <summary>
/// LiveKit webhook (raw body JWT + sha256). Prefer egress_ended → finalize service.
/// </summary>
app.MapPost("/api/livekit/webhook", async (
    HttpRequest request,
    LiveKitWebhookValidator validator,
    RecordingFinalizeService finalize,
    ILoggerFactory loggerFactory,
    CancellationToken cancellationToken) =>
{
    var log = loggerFactory.CreateLogger("LiveKitWebhook");
    request.EnableBuffering();
    using var reader = new StreamReader(request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
    var rawBody = await reader.ReadToEndAsync(cancellationToken);
    request.Body.Position = 0;

    var auth = request.Headers.Authorization.ToString();
    if (!validator.TryValidate(auth, rawBody, out var verr))
    {
        log.LogWarning("Webhook rejected: {Error}", verr);
        return Results.Unauthorized();
    }

    string? eventName = null;
    string? egressId = null;
    string? egressStatus = null;
    string? egressError = null;
    string? egressErrorCode = null;
    try
    {
        using var doc = JsonDocument.Parse(rawBody);
        var root = doc.RootElement;
        if (root.TryGetProperty("event", out var ev)) eventName = ev.GetString();
        JsonElement infoEl = default;
        var hasInfo = root.TryGetProperty("egressInfo", out infoEl)
                      || root.TryGetProperty("egress_info", out infoEl);
        if (hasInfo && infoEl.ValueKind == JsonValueKind.Object)
        {
            if (infoEl.TryGetProperty("egressId", out var idEl) || infoEl.TryGetProperty("egress_id", out idEl))
                egressId = idEl.GetString();
            if (infoEl.TryGetProperty("status", out var stEl))
                egressStatus = stEl.ValueKind == JsonValueKind.String
                    ? stEl.GetString()
                    : stEl.ToString();
            if (infoEl.TryGetProperty("error", out var errEl))
                egressError = errEl.GetString();
            if (infoEl.TryGetProperty("errorCode", out var codeEl) || infoEl.TryGetProperty("error_code", out codeEl))
                egressErrorCode = codeEl.ToString();
        }
    }
    catch (Exception ex)
    {
        log.LogWarning(ex, "Webhook JSON parse failed after signature OK");
        return Results.BadRequest(new { error = "invalid json" });
    }

    if (eventName is "egress_ended" or "egress_updated" && !string.IsNullOrWhiteSpace(egressId))
    {
        // Dual-catalog: try media_assets first; only fall through when NOT found
        var mediaResult = await finalize.ApplyMediaEgressStatusAsync(
            egressId!,
            egressStatus,
            egressError,
            egressErrorCode,
            cancellationToken);
        if (mediaResult.Found)
        {
            log.LogInformation(
                "Webhook {Event} media egress {EgressId} found=true changed={Changed} status={Status}",
                eventName, egressId, mediaResult.Changed, mediaResult.NewStatus);
        }
        else
        {
            var result = await finalize.ApplyEgressStatusAsync(
                egressId!,
                egressStatus,
                egressError,
                egressErrorCode,
                cancellationToken);
            log.LogInformation("Webhook {Event} recording egress {EgressId} changed={Changed} status={Status}",
                eventName, egressId, result.Changed, result.NewStatus);
        }
    }

    return Results.Ok(new { received = true });
});

/// <summary>
/// PoC/test hook: plant a Complete clinic-scoped recording object without Egress finalize.
/// Manager same clinic only. Used to prove download/delete/retention on real storage path.
/// </summary>
app.MapPost("/api/calls/{id:guid}/recording/plant-complete", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit,
    CallDispatcher dispatcher,
    PlantRecordingRequest? body,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var call = RecordingAuthorization.GetClinicCallForManager(calls, id, current);
    if (call is null) return Results.NotFound();

    lock (call.SyncRoot)
    {
        if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
            return Results.Conflict(new { error = "Cannot plant over an active recording." });
    }

    var recId = Guid.NewGuid().ToString("N");
    var key = storage.BuildKey(call.ClinicId, call.Id, recId, "mp4");
    var tmp = Path.Combine(Path.GetTempPath(), $"plant-{recId}.mp4");
    await File.WriteAllBytesAsync(tmp, System.Text.Encoding.UTF8.GetBytes(
        "simlydent-poc-planted-recording\n" + call.Id.ToString("N") + "\n"), cancellationToken);
    try
    {
        await storage.SaveFromLocalFileAsync(key, tmp, cancellationToken);
    }
    finally
    {
        try { File.Delete(tmp); } catch { /* ignore */ }
    }

    if (!await storage.ExistsAsync(key, cancellationToken))
        return Results.Json(new { error = "Plant failed: object missing after save." }, statusCode: 503);

    var ageDays = body?.AgeDays ?? 0;
    var updatedAt = ageDays > 0
        ? DateTimeOffset.UtcNow.AddDays(-ageDays)
        : DateTimeOffset.UtcNow;
    var policy = policies.Get(call.ClinicId);
    var mode = call.RecordingMode == RecordingMode.None ? RecordingMode.Video : call.RecordingMode;
    var retentionUntil = updatedAt.AddDays(policy.RetentionDays);

    try
    {
        var plantEgress = "plant-" + recId;
        await catalog.InsertRequestedAsync(
            recId, call.ClinicId, call.Id, mode.ToString(), key, "Composite",
            retentionUntil, call.CallerId, call.AssignedStaffId ?? call.CalleeId,
            call.Status.ToString(), call.ConsentStatus.ToString(), fileName: null, cancellationToken);
        await catalog.TryMarkRecordingAsync(recId, plantEgress, cancellationToken);
        await catalog.TryMarkReadyAsync(recId, plantEgress, key, cancellationToken: cancellationToken);
    }
    catch (Exception ex)
    {
        return Results.Json(new { error = $"Plant catalog failed: {ex.Message}" }, statusCode: 503);
    }

    lock (call.SyncRoot)
    {
        call.RecordingMode = mode;
        call.RecordingId = recId;
        call.RecordingStorageKey = key;
        call.RecordingStatus = "Complete";
        call.UpdatedAt = updatedAt;
    }

    audit.Append(call.ClinicId, call.Id, recId, current.Id, current.Role,
        "RecordingStopped", "Ok", "plant-complete");
    await dispatcher.NotifyCallAsync(call);
    return Results.Ok(new
    {
        storageKey = key,
        recording = RecordingAuthorization.BuildView(call, current, policy)
    });
}).RequireAuthorization();

/// <summary>
/// Issue temporary download capability. Catalog is authority (works after API restart).
/// mode=presign → browser hits Object Storage; mode=proxy → relative file stream URL.
/// Audit: RecordingDownloadUrlIssued (does not prove bytes were fetched).
/// </summary>
app.MapGet("/api/calls/{callId:guid}/recording/download-url", async (
    Guid callId,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    RecordingAuditService audit,
    IConfiguration configuration,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var denied = RecordingAuthorization.RequireManager(current);
    if (denied is not null) return denied;

    var ledger = await catalog.GetLatestByCallAsync(callId, cancellationToken);
    if (ledger is null
        || !string.Equals(ledger.ClinicId, current!.ClinicId, StringComparison.OrdinalIgnoreCase))
        return Results.NotFound();

    if (!RecordingLedgerStatus.IsDownloadable(ledger.Status)
        || string.IsNullOrWhiteSpace(ledger.StorageKey))
        return Results.Conflict(new { error = "Recording is not ready." });

    var ttlSec = 300;
    if (int.TryParse(configuration["RECORDING_PRESIGN_TTL_SECONDS"], out var t) && t > 0)
        ttlSec = Math.Min(t, 900);
    var ttl = TimeSpan.FromSeconds(ttlSec);
    var expiresAt = DateTimeOffset.UtcNow.Add(ttl);

    string mode;
    string url;
    if (storage.SupportsPresignedGet)
    {
        var signed = storage.CreatePresignedGetUrl(ledger.StorageKey!, ttl);
        if (string.IsNullOrWhiteSpace(signed))
            return Results.Json(new { error = "Presign unavailable." }, statusCode: 503);
        mode = "presign";
        url = signed;
    }
    else
    {
        mode = "proxy";
        url = $"/api/calls/{callId:D}/recording/file";
    }

    // Never put full signed URL in audit detail.
    audit.Append(ledger.ClinicId, ledger.CallId, ledger.Id, current.Id, current.Role,
        "RecordingDownloadUrlIssued", "Ok", $"mode={mode};ttlSec={ttlSec}");

    return Results.Ok(new
    {
        url,
        expiresAt,
        mode,
        recordingId = ledger.Id,
        callId = ledger.CallId
    });
}).RequireAuthorization();

/// <summary>
/// Proxy stream path — only when mode=proxy or scripts. Catalog authority.
/// Audit RecordingDownloaded only when bytes leave this endpoint.
/// </summary>
app.MapGet("/api/calls/{id:guid}/recording/file", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    RecordingAuditService audit,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var denied = RecordingAuthorization.RequireManager(current);
    if (denied is not null) return denied;

    var ledger = await catalog.GetLatestByCallAsync(id, cancellationToken);
    if (ledger is null
        || !string.Equals(ledger.ClinicId, current!.ClinicId, StringComparison.OrdinalIgnoreCase))
        return Results.NotFound();

    if (!RecordingLedgerStatus.IsDownloadable(ledger.Status)
        || string.IsNullOrWhiteSpace(ledger.StorageKey))
        return Results.Conflict(new { error = "Recording is not ready." });

    var stream = await storage.OpenReadAsync(ledger.StorageKey!, cancellationToken);
    if (stream is null)
    {
        audit.Append(ledger.ClinicId, ledger.CallId, ledger.Id, current.Id, current.Role,
            "RecordingDownloaded", "Failed", "missing object");
        return Results.NotFound(new { error = "Recording file was not found." });
    }

    audit.Append(ledger.ClinicId, ledger.CallId, ledger.Id, current.Id, current.Role,
        "RecordingDownloaded", "Ok", "proxy");
    var downloadName = $"recording-{ledger.CallId:N}.mp4";
    return Results.File(stream, "video/mp4", downloadName, enableRangeProcessing: true);
}).RequireAuthorization();

app.MapDelete("/api/calls/{id:guid}/recording", async (
    Guid id,
    ClaimsPrincipal principal,
    IdentityRegistry identities,
    ConcurrentDictionary<Guid, CallSession> calls,
    IRecordingStorage storage,
    IRecordingCatalog catalog,
    RecordingAuditService audit,
    CallDispatcher dispatcher,
    CancellationToken cancellationToken) =>
{
    var current = ClinicAuthorization.CurrentUser(principal, identities);
    if (current is null) return Results.Unauthorized();
    var denied = RecordingAuthorization.RequireManager(current);
    if (denied is not null) return denied;

    var call = RecordingAuthorization.GetClinicCallForManager(calls, id, current);
    string? key = null;
    string? recId = null;
    var clinicId = current!.ClinicId;

    if (call is not null)
    {
        clinicId = call.ClinicId;
        lock (call.SyncRoot)
        {
            if (call.RecordingStatus is "Starting" or "Recording" or "Stopping")
                return Results.Conflict(new { error = "Cannot delete an active recording." });
            key = call.RecordingStorageKey;
            recId = call.RecordingId;
            if (call.RecordingStatus == "Deleted" && string.IsNullOrWhiteSpace(key))
                return Results.Ok(new { status = "Deleted" });
        }
    }

    // Catalog survives API restart even when CallSession is gone.
    var latest = await catalog.GetLatestByCallAsync(id, cancellationToken);
    if (latest is not null)
    {
        if (!string.Equals(latest.ClinicId, current.ClinicId, StringComparison.OrdinalIgnoreCase))
            return Results.NotFound();
        if (RecordingLedgerStatus.IsActive(latest.Status))
            return Results.Conflict(new { error = "Cannot delete an active recording." });
        recId ??= latest.Id;
        key ??= latest.StorageKey;
        clinicId = latest.ClinicId;
        if (latest.Status == RecordingLedgerStatus.Deleted && string.IsNullOrWhiteSpace(key))
            return Results.Ok(new { status = "Deleted" });
    }
    else if (call is null)
    {
        return Results.NotFound();
    }

    if (!string.IsNullOrWhiteSpace(key))
    {
        try
        {
            await storage.DeleteAsync(key, cancellationToken);
        }
        catch (Exception ex)
        {
            audit.Append(clinicId, id, recId, current.Id, current.Role,
                "RecordingDeleted", "Failed", ex.Message);
            return Results.Json(new { error = ex.Message }, statusCode: 503);
        }
    }

    if (call is not null)
    {
        lock (call.SyncRoot)
        {
            call.RecordingStatus = "Deleted";
            call.RecordingStorageKey = null;
            call.RecordingFileName = null;
            call.RecordingEgressId = null;
            call.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await dispatcher.NotifyCallAsync(call);
    }

    if (!string.IsNullOrWhiteSpace(recId))
    {
        try { await catalog.MarkDeletedAsync(recId, cancellationToken); }
        catch { /* best-effort */ }
    }
    audit.Append(clinicId, id, recId, current.Id, current.Role,
        "RecordingDeleted", "Ok");
    return Results.Ok(new { status = "Deleted" });
}).RequireAuthorization();

// Embed visitor consent (session ownership)
app.MapPost("/embed/calls/{id:guid}/recording/consent", (
    Guid id,
    SetConsentRequest body,
    ClaimsPrincipal principal,
    ConcurrentDictionary<Guid, CallSession> calls,
    RecordingPolicyRegistry policies,
    RecordingAuditService audit) =>
{
    var session = EmbedAuthTokenService.TryReadSession(principal);
    if (session is null) return Results.Unauthorized();
    var call = ClinicAuthorization.GetEmbedOwnedCall(calls, id, session);
    if (call is null) return Results.NotFound();
    if (!Enum.TryParse<ConsentStatus>(body.Status, ignoreCase: true, out var consent)
        || consent == ConsentStatus.Pending)
        return Results.BadRequest(new { error = "Status must be Granted or Declined." });
    var policy = policies.Get(call.ClinicId);
    lock (call.SyncRoot)
    {
        call.ConsentStatus = consent;
        call.ConsentActorId = session.VisitorId;
        call.ConsentPolicyVersion = policy.Version;
        call.ConsentGrantedAt = consent == ConsentStatus.Granted ? DateTimeOffset.UtcNow : null;
        call.UpdatedAt = DateTimeOffset.UtcNow;
    }
    audit.Append(call.ClinicId, call.Id, call.RecordingId, session.VisitorId, IdentityRoles.Visitor,
        consent == ConsentStatus.Granted ? "ConsentGranted" : "ConsentDeclined", "Ok");
    return Results.Ok(EmbedCallView.From(call));
}).RequireAuthorization("EmbedVisitor").RequireCors("EmbedCors");

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

/// <summary>Optional body for plant-complete test hook (AgeDays backdates UpdatedAt for retention).</summary>
file sealed record PlantRecordingRequest(int AgeDays = 0);
