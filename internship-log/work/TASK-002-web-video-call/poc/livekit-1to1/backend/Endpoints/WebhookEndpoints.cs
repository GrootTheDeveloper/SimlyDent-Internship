using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public static class WebhookEndpoints
{
    public static IEndpointRouteBuilder MapWebhookEndpoints(this IEndpointRouteBuilder app)
    {
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

        return app;
    }
}
