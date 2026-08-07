using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using LiveKitPoc.Api;
using LiveKitPoc.Api.Options;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.SignalR;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddPocOptions(builder.Configuration);

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
builder.Services.AddSingleton<RecordingOrchestrationService>();
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

// Typed options + S3 capability fail-fast (never log secret values).
try
{
    PocOptionsRegistration.ValidatePocOptionsOrThrow(app);
}
catch (Exception ex)
{
    app.Logger.LogCritical(ex, "Fatal configuration error (options / S3).");
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

app.MapHealthEndpoints();
app.MapAuthEndpoints();
app.MapEmbedEndpoints();
app.MapDirectoryEndpoints();
app.MapQueueEndpoints();
app.MapCallEndpoints();
app.MapRecordingEndpoints();
app.MapWebhookEndpoints();
app.MapQualityEndpoints();

app.MapHub<CallHub>("/hubs/calls").RequireAuthorization();
app.Run();
