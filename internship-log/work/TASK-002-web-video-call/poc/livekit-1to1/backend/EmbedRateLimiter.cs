using System.Collections.Concurrent;
using System.Net;

namespace LiveKitPoc.Api;

/// <summary>
/// Simple in-memory sliding window rate limiter for embed bootstrap/calls (PoC).
/// Buckets older than 2 windows are pruned opportunistically.
/// </summary>
public sealed class EmbedRateLimiter
{
    private readonly ConcurrentDictionary<string, Window> _windows = new(StringComparer.Ordinal);
    private readonly int _maxPerWindow;
    private readonly TimeSpan _window;
    private int _acquireCount;

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
        if (Interlocked.Increment(ref _acquireCount) % 64 == 0)
            Prune(now);

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

    private void Prune(DateTimeOffset now)
    {
        var staleBefore = now - _window - _window;
        foreach (var kv in _windows)
        {
            lock (kv.Value.Sync)
            {
                if (kv.Value.StartedAt < staleBefore && kv.Value.Count == 0)
                    _windows.TryRemove(kv.Key, out _);
                else if (kv.Value.StartedAt < staleBefore)
                    _windows.TryRemove(kv.Key, out _);
            }
        }
    }

    /// <summary>
    /// Prefer connection remote IP after ASP.NET Forwarded Headers middleware
    /// (trusted proxy only). Falls back to X-Real-IP / raw connection.
    /// </summary>
    public static string GetClientIp(HttpContext http)
    {
        var remote = http.Connection.RemoteIpAddress;
        if (remote is not null)
        {
            if (remote.IsIPv4MappedToIPv6)
                remote = remote.MapToIPv4();
            return remote.ToString();
        }
        // Fallback if forwarded headers not configured.
        var realIp = http.Request.Headers["X-Real-IP"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(realIp) && IPAddress.TryParse(realIp.Trim(), out _))
            return realIp.Trim();
        return "unknown";
    }

    private sealed class Window
    {
        public object Sync { get; } = new();
        public DateTimeOffset StartedAt { get; set; } = DateTimeOffset.UtcNow;
        public int Count { get; set; }
    }
}
