using System.Collections.Concurrent;
using System.Net;

namespace LiveKitPoc.Api;

/// <summary>
/// Simple in-memory sliding window rate limiter for embed bootstrap/calls (PoC).
/// </summary>
public sealed class EmbedRateLimiter
{
    private readonly ConcurrentDictionary<string, Window> _windows = new(StringComparer.Ordinal);
    private readonly int _maxPerWindow;
    private readonly TimeSpan _window;

    public EmbedRateLimiter(IConfiguration configuration)
    {
        _maxPerWindow = int.TryParse(configuration["EMBED_RATE_LIMIT_PER_MINUTE"], out var n)
            ? Math.Clamp(n, 5, 1000)
            : 30;
        _window = TimeSpan.FromMinutes(1);
    }

    public bool TryAcquire(string key)
    {
        var now = DateTimeOffset.UtcNow;
        var bucket = _windows.GetOrAdd(key, _ => new Window());
        lock (bucket.Sync)
        {
            if (now - bucket.StartedAt >= _window)
            {
                bucket.StartedAt = now;
                bucket.Count = 0;
            }
            if (bucket.Count >= _maxPerWindow)
                return false;
            bucket.Count++;
            return true;
        }
    }

    /// <summary>
    /// Client IP from reverse proxy. Trusts X-Forwarded-For / X-Real-IP first hop only (PoC).
    /// </summary>
    public static string GetClientIp(HttpContext http)
    {
        var forwarded = http.Request.Headers["X-Forwarded-For"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(forwarded))
        {
            // Caddy appends; leftmost is original client when Caddy is the only trusted proxy.
            var first = forwarded.Split(',')[0].Trim();
            if (IPAddress.TryParse(first, out _))
                return first;
        }
        var realIp = http.Request.Headers["X-Real-IP"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(realIp) && IPAddress.TryParse(realIp.Trim(), out _))
            return realIp.Trim();
        return http.Connection.RemoteIpAddress?.ToString() ?? "unknown";
    }

    private sealed class Window
    {
        public object Sync { get; } = new();
        public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
        public int Count { get; set; }
    }
}
