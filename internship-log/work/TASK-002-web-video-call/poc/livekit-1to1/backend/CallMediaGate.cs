using System.Collections.Concurrent;

namespace LiveKitPoc.Api;

/// <summary>
/// Per-call async gate coordinating StartClip and graceful End barrier discovery.
/// Never hold call.SyncRoot across network awaits — only this gate.
/// Invariant: either StartClip finishes critical section (egress id present or aborted),
/// or End has claimed GracefulEndPending and StartClip must not StartEgress.
/// </summary>
public sealed class CallMediaGate
{
    private readonly ConcurrentDictionary<Guid, SemaphoreSlim> _gates = new();

    private SemaphoreSlim GateFor(Guid callId) =>
        _gates.GetOrAdd(callId, static _ => new SemaphoreSlim(1, 1));

    public async Task<IDisposable> AcquireAsync(Guid callId, CancellationToken ct = default)
    {
        var gate = GateFor(callId);
        await gate.WaitAsync(ct).ConfigureAwait(false);
        return new Releaser(gate);
    }

    public async Task<bool> TryAcquireAsync(Guid callId, TimeSpan timeout, CancellationToken ct = default)
    {
        var gate = GateFor(callId);
        return await gate.WaitAsync(timeout, ct).ConfigureAwait(false);
    }

    public void Release(Guid callId)
    {
        if (_gates.TryGetValue(callId, out var gate))
            gate.Release();
    }

    private sealed class Releaser(SemaphoreSlim gate) : IDisposable
    {
        private int _disposed;
        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                gate.Release();
        }
    }
}

/// <summary>Result of dental egress barrier discovery — never fail-open to empty.</summary>
public enum BarrierLookupKind
{
    /// <summary>Catalog query OK and no dental clip needs protection.</summary>
    KnownEmpty,
    /// <summary>Catalog query OK; one or more assets need source track / stop.</summary>
    KnownBarriers,
    /// <summary>Catalog/query failed or ambiguous — must not fast-path End.</summary>
    Unknown
}

public sealed record BarrierLookupResult(
    BarrierLookupKind Kind,
    IReadOnlyList<MediaAsset> Barriers,
    string? Error = null)
{
    public static BarrierLookupResult Empty() =>
        new(BarrierLookupKind.KnownEmpty, Array.Empty<MediaAsset>());

    public static BarrierLookupResult WithBarriers(IReadOnlyList<MediaAsset> barriers) =>
        new(BarrierLookupKind.KnownBarriers, barriers);

    public static BarrierLookupResult Unknown(string error) =>
        new(BarrierLookupKind.Unknown, Array.Empty<MediaAsset>(), error);

    public bool MayFastPathEnd => Kind == BarrierLookupKind.KnownEmpty;

    public bool NeedsGracefulWait =>
        Kind is BarrierLookupKind.KnownBarriers or BarrierLookupKind.Unknown;
}
