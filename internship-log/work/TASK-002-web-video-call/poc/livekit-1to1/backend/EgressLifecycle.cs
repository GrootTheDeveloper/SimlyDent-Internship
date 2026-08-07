namespace LiveKitPoc.Api;

/// <summary>
/// LiveKit Egress status helpers. Safe disconnect barrier is Egress terminal,
/// NOT application asset Ready (webhook/reconcile/catalog may lag).
/// </summary>
public static class EgressLifecycle
{
    /// <summary>
    /// Normalize LiveKit status strings: EGRESS_COMPLETE → COMPLETE, etc.
    /// </summary>
    public static string Normalize(string? status)
    {
        var st = (status ?? "").Trim().ToUpperInvariant();
        if (st.StartsWith("EGRESS_", StringComparison.Ordinal))
            st = st["EGRESS_".Length..];
        return st;
    }

    /// <summary>
    /// Egress finished capture/mux path. Source track no longer required.
    /// COMPLETE / LIMIT_REACHED = success path; FAILED / ABORTED = error path (still terminal).
    /// ENDING is NOT terminal (still flushing).
    /// </summary>
    public static bool IsTerminal(string? status)
    {
        var st = Normalize(status);
        return st is "COMPLETE" or "LIMIT_REACHED" or "FAILED" or "ABORTED";
    }

    public static bool IsSuccessfulTerminal(string? status)
    {
        var st = Normalize(status);
        return st is "COMPLETE" or "LIMIT_REACHED";
    }

    public static bool IsFailedTerminal(string? status)
    {
        var st = Normalize(status);
        return st is "FAILED" or "ABORTED";
    }

    /// <summary>Still actively capturing or shutting down — keep source track if TrackComposite.</summary>
    public static bool NeedsSourceTrack(string? status)
    {
        if (string.IsNullOrWhiteSpace(status)) return true;
        if (IsTerminal(status)) return false;
        var st = Normalize(status);
        // STARTING, ACTIVE, ENDING, empty → still depend on source
        return st is "STARTING" or "ACTIVE" or "ENDING" or "";
    }
}
