namespace LiveKitPoc.Api;

/// <summary>
/// Exact origin comparison: scheme + host + port only.
/// Never uses EndsWith/Contains substring host matching.
/// </summary>
public static class OriginMatcher
{
    public static bool TryParseOrigin(string? origin, out Uri? uri)
    {
        uri = null;
        if (string.IsNullOrWhiteSpace(origin))
            return false;
        var trimmed = origin.Trim();
        if (string.Equals(trimmed, "null", StringComparison.OrdinalIgnoreCase))
            return false;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var parsed))
            return false;
        if (parsed.Scheme is not ("http" or "https"))
            return false;
        uri = parsed;
        return true;
    }

    /// <summary>Exact match of scheme, host (IDN), and port.</summary>
    public static bool EqualsExact(string? requestOrigin, string allowedOrigin)
    {
        if (!TryParseOrigin(requestOrigin, out var a) || a is null)
            return false;
        if (!TryParseOrigin(allowedOrigin, out var b) || b is null)
            return false;

        return string.Equals(a.Scheme, b.Scheme, StringComparison.OrdinalIgnoreCase)
               && string.Equals(a.IdnHost, b.IdnHost, StringComparison.OrdinalIgnoreCase)
               && a.Port == b.Port;
    }

    public static bool IsAllowed(string? requestOrigin, IEnumerable<string> allowedOrigins) =>
        allowedOrigins.Any(allowed => EqualsExact(requestOrigin, allowed));
}
