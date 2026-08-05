using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

public sealed class CleanupWorker : BackgroundService
{
    private readonly IServiceScopeFactory _scopeFactory;

    public CleanupWorker(IServiceScopeFactory scopeFactory)
        => _scopeFactory = scopeFactory;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(5));

        try
        {
            do
            {
                await using var scope = _scopeFactory.CreateAsyncScope();
                var cleanup = scope.ServiceProvider
                    .GetRequiredService<ICleanupService>();

                await cleanup.RunAsync(stoppingToken);
            }
            while (await timer.WaitForNextTickAsync(stoppingToken));
        }
        catch (OperationCanceledException)
            when (stoppingToken.IsCancellationRequested)
        {
            // Graceful shutdown requested by the Host.
        }
    }
}

public interface ICleanupService
{
    Task RunAsync(CancellationToken cancellationToken);
}
