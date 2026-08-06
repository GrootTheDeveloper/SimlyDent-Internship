namespace LiveKitPoc.Api;

/// <summary>
/// Public site_key → clinic mapping (Phase 2). site_key is not a secret.
/// ClinicId is never taken from the browser body.
/// </summary>
public sealed class ClinicSite
{
    public required string SiteId { get; init; }
    public required string SiteKey { get; init; }
    public required string ClinicId { get; init; }
    public required IReadOnlyList<string> AllowedOrigins { get; init; }
    public bool Enabled { get; init; } = true;
}

public sealed class ClinicSiteRegistry
{
    public const string SiteKeyClinicA = "pk_clinic_a";
    public const string SiteKeyClinicB = "pk_clinic_b";

    private readonly Dictionary<string, ClinicSite> _byKey =
        new(StringComparer.Ordinal);

    public ClinicSiteRegistry(IConfiguration configuration)
    {
        var originsA = ParseOrigins(
            configuration["EMBED_ORIGINS_CLINIC_A"],
            defaultOrigins:
            [
                "http://127.0.0.1:5174",
                "http://localhost:5174",
                "http://127.0.0.1:5500",
                "http://localhost:5500"
            ]);
        var originsB = ParseOrigins(
            configuration["EMBED_ORIGINS_CLINIC_B"],
            defaultOrigins:
            [
                "http://127.0.0.1:5175",
                "http://localhost:5175",
                "http://127.0.0.1:5501",
                "http://localhost:5501"
            ]);

        // Optional: append VPS public domain as allowed parent for demos (exact full origin).
        var publicOrigin = configuration["EMBED_PUBLIC_ORIGIN"];
        if (!string.IsNullOrWhiteSpace(publicOrigin))
        {
            originsA = originsA.Append(publicOrigin.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            originsB = originsB.Append(publicOrigin.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        }

        Add(new ClinicSite
        {
            SiteId = "site-a",
            SiteKey = SiteKeyClinicA,
            ClinicId = IdentityRegistry.ClinicA,
            AllowedOrigins = originsA,
            Enabled = !string.Equals(configuration["EMBED_DISABLE_CLINIC_A"], "1", StringComparison.OrdinalIgnoreCase)
        });
        Add(new ClinicSite
        {
            SiteId = "site-b",
            SiteKey = SiteKeyClinicB,
            ClinicId = IdentityRegistry.ClinicB,
            AllowedOrigins = originsB,
            Enabled = !string.Equals(configuration["EMBED_DISABLE_CLINIC_B"], "1", StringComparison.OrdinalIgnoreCase)
        });
    }

    private void Add(ClinicSite site) => _byKey[site.SiteKey] = site;

    public ClinicSite? FindBySiteKey(string? siteKey) =>
        !string.IsNullOrWhiteSpace(siteKey) && _byKey.TryGetValue(siteKey.Trim(), out var site)
            ? site
            : null;

    public IReadOnlyCollection<string> AllAllowedOrigins =>
        _byKey.Values.SelectMany(s => s.AllowedOrigins).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();

    public IReadOnlyCollection<ClinicSite> All => _byKey.Values.ToArray();

    private static string[] ParseOrigins(string? csv, string[] defaultOrigins)
    {
        if (string.IsNullOrWhiteSpace(csv))
            return defaultOrigins;
        return csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(o => OriginMatcher.TryParseOrigin(o, out _))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }
}
