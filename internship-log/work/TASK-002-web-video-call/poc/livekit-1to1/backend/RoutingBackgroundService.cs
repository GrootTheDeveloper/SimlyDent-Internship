namespace LiveKitPoc.Api;

/// <summary>
/// Periodic ring/visitor/stale-agent sweep for Phase 1 auto-dispatch.
/// </summary>
public sealed class RoutingBackgroundService(IServiceProvider services, ILogger<RoutingBackgroundService> log)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Small delay so the app finishes startup.
        await Task.Delay(TimeSpan.FromSeconds(2), stoppingToken);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = services.CreateScope();
                var dispatcher = scope.ServiceProvider.GetRequiredService<CallDispatcher>();
                await dispatcher.SweepAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Routing sweep failed");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(1), stoppingToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }
}
