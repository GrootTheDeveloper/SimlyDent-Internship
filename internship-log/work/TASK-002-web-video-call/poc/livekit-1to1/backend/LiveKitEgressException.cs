namespace LiveKitPoc.Api;

/// <summary>
/// Classification for LiveKit Egress control-plane failures.
/// Callers use this to decide whether a second StartEgress is safe.
/// </summary>
public enum LiveKitEgressErrorClass
{
    /// <summary>
    /// Deterministic client rejection (e.g. HTTP 400/422, Twirp invalid_argument / unimplemented).
    /// Backend can treat the start request as not accepted — safe to retry with a different payload.
    /// </summary>
    RequestRejected,

    /// <summary>
    /// Timeout, cancellation, connection reset, or other transport failure.
    /// Egress may already exist server-side — must NOT StartEgress again.
    /// </summary>
    TransportUnknown,

    /// <summary>
    /// HTTP 5xx or equivalent server-side failure. Outcome of the original request is ambiguous.
    /// </summary>
    ServerFailure,

    /// <summary>Auth, conflict, not found, or other non-retry-start cases.</summary>
    Other
}

/// <summary>
/// Typed Egress Twirp/HTTP failure with enough context for safe fallback decisions.
/// </summary>
public sealed class LiveKitEgressException : Exception
{
    public LiveKitEgressException(
        string method,
        LiveKitEgressErrorClass classification,
        string message,
        int? httpStatus = null,
        string? twirpCode = null,
        string? twirpMessage = null,
        Exception? inner = null)
        : base(message, inner)
    {
        Method = method;
        Classification = classification;
        HttpStatus = httpStatus;
        TwirpCode = twirpCode;
        TwirpMessage = twirpMessage;
    }

    public string Method { get; }
    public LiveKitEgressErrorClass Classification { get; }
    public int? HttpStatus { get; }
    public string? TwirpCode { get; }
    public string? TwirpMessage { get; }

    /// <summary>
    /// True only when the first StartEgress is known not to have been accepted,
    /// so a different payload (e.g. legacy preset) may be attempted once.
    /// </summary>
    public bool IsSafeToRetryStartWithDifferentPayload =>
        Classification == LiveKitEgressErrorClass.RequestRejected
        && IsDeterministicClientRejection(HttpStatus, TwirpCode);

    public static bool IsDeterministicClientRejection(int? httpStatus, string? twirpCode)
    {
        var code = (twirpCode ?? "").Trim().ToLowerInvariant();
        if (code is "invalid_argument" or "failed_precondition" or "unimplemented"
            or "out_of_range" or "bad_route")
            return true;

        // Classic client validation failures — not auth/conflict/timeout.
        if (httpStatus is 400 or 422)
            return true;

        return false;
    }

    public static LiveKitEgressErrorClass ClassifyHttp(int statusCode, string? twirpCode)
    {
        if (statusCode is 408 or 429)
            return LiveKitEgressErrorClass.TransportUnknown;
        if (statusCode >= 500)
            return LiveKitEgressErrorClass.ServerFailure;
        // Auth / missing / conflict: request outcome is not "safe re-start with new payload".
        if (statusCode is 401 or 403 or 404 or 409)
            return LiveKitEgressErrorClass.Other;
        if (statusCode is >= 400 and < 500)
            return LiveKitEgressErrorClass.RequestRejected;
        return LiveKitEgressErrorClass.Other;
    }

    public static LiveKitEgressErrorClass ClassifyTransport(Exception ex)
    {
        if (ex is OperationCanceledException or TaskCanceledException or TimeoutException)
            return LiveKitEgressErrorClass.TransportUnknown;
        if (ex is HttpRequestException or IOException)
            return LiveKitEgressErrorClass.TransportUnknown;
        return LiveKitEgressErrorClass.Other;
    }
}
