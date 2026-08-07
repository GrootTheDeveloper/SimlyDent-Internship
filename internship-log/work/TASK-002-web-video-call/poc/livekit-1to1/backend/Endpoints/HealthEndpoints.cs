using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
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

        return app;
    }
}
