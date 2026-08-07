using System.Collections.Concurrent;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;

namespace LiveKitPoc.Api;

public static class QualityEndpoints
{
    public static IEndpointRouteBuilder MapQualityEndpoints(this IEndpointRouteBuilder app)
    {
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

        return app;
    }
}
