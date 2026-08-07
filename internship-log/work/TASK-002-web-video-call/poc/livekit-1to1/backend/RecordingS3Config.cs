namespace LiveKitPoc.Api;

/// <summary>
/// Capability-based S3 validation (Phase C hard rules).
/// Fail-fast by mode — not a single blunt OR for all settings.
/// </summary>
public static class RecordingS3Config
{
    public static void ValidateOrThrow(IConfiguration configuration, ILogger logger)
    {
        var egressOut = (configuration["EGRESS_OUTPUT"] ?? "local").Trim().ToLowerInvariant();
        var storage = (configuration["RECORDING_STORAGE"] ?? "local").Trim().ToLowerInvariant();
        var requirePresign = string.Equals(configuration["REQUIRE_PRESIGNED_DOWNLOAD"], "1", StringComparison.OrdinalIgnoreCase)
                             || string.Equals(configuration["REQUIRE_PRESIGNED_DOWNLOAD"], "true", StringComparison.OrdinalIgnoreCase);

        var errors = new List<string>();

        if (egressOut is "s3" or "minio")
        {
            var publicEp = GetPublicEndpoint(configuration);
            if (string.IsNullOrWhiteSpace(publicEp))
                errors.Add("EGRESS_OUTPUT=s3 requires S3_PUBLIC_ENDPOINT (HTTPS dedicated host, e.g. https://s3.example.com).");
            else if (!publicEp.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                errors.Add("EGRESS_OUTPUT=s3 requires S3_PUBLIC_ENDPOINT to use https:// (LiveKit custom S3).");
            else if (publicEp.Contains("/s3", StringComparison.OrdinalIgnoreCase)
                     && !Uri.TryCreate(publicEp, UriKind.Absolute, out var u))
                errors.Add("S3_PUBLIC_ENDPOINT must be a host origin, not a path prefix like https://domain/s3.");
            else if (Uri.TryCreate(publicEp, UriKind.Absolute, out var pubUri)
                     && !string.IsNullOrEmpty(pubUri.AbsolutePath.TrimEnd('/'))
                     && pubUri.AbsolutePath != "/")
                errors.Add("S3_PUBLIC_ENDPOINT must be origin-only (no path). Use https://s3.DOMAIN not https://DOMAIN/s3.");

            if (string.IsNullOrWhiteSpace(configuration["S3_BUCKET"]))
                errors.Add("EGRESS_OUTPUT=s3 requires S3_BUCKET.");
            if (string.IsNullOrWhiteSpace(configuration["S3_ACCESS_KEY"])
                || string.IsNullOrWhiteSpace(configuration["S3_SECRET_KEY"]))
                errors.Add("EGRESS_OUTPUT=s3 requires S3_ACCESS_KEY and S3_SECRET_KEY (write-capable lab account).");
        }

        if (storage is "s3" or "minio")
        {
            var internalEp = (configuration["S3_INTERNAL_ENDPOINT"]
                              ?? configuration["S3_ENDPOINT"]
                              ?? "").Trim();
            if (string.IsNullOrWhiteSpace(internalEp))
                errors.Add("RECORDING_STORAGE=s3 requires S3_INTERNAL_ENDPOINT (or S3_ENDPOINT).");
            if (string.IsNullOrWhiteSpace(configuration["S3_BUCKET"]))
                errors.Add("RECORDING_STORAGE=s3 requires S3_BUCKET.");
            if (string.IsNullOrWhiteSpace(configuration["S3_ACCESS_KEY"])
                || string.IsNullOrWhiteSpace(configuration["S3_SECRET_KEY"]))
                errors.Add("RECORDING_STORAGE=s3 requires S3_ACCESS_KEY and S3_SECRET_KEY.");
        }

        if (requirePresign)
        {
            var publicEp = GetPublicEndpoint(configuration);
            if (string.IsNullOrWhiteSpace(publicEp)
                || !publicEp.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                errors.Add("REQUIRE_PRESIGNED_DOWNLOAD=1 requires S3_PUBLIC_ENDPOINT https://...");
        }

        // Warn if using default minioadmin on public-facing lab
        var access = configuration["S3_ACCESS_KEY"] ?? "";
        if ((egressOut is "s3" or "minio" || storage is "s3" or "minio")
            && string.Equals(access, "minioadmin", StringComparison.OrdinalIgnoreCase))
        {
            logger.LogWarning(
                "S3_ACCESS_KEY is minioadmin (root). Phase C requires a non-root bucket-scoped lab account for public HTTPS.");
        }

        if (errors.Count > 0)
            throw new InvalidOperationException(
                "Recording S3 configuration invalid:\n- " + string.Join("\n- ", errors));
    }

    public static string GetPublicEndpoint(IConfiguration configuration) =>
        (configuration["S3_PUBLIC_ENDPOINT"] ?? "").Trim().TrimEnd('/');

    public static string GetInternalEndpoint(IConfiguration configuration) =>
        (configuration["S3_INTERNAL_ENDPOINT"]
         ?? configuration["S3_ENDPOINT"]
         ?? "http://minio:9000").Trim().TrimEnd('/');
}
