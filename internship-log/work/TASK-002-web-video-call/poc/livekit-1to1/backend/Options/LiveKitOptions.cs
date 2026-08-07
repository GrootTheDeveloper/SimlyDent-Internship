namespace LiveKitPoc.Api.Options;

/// <summary>LiveKit SFU / Egress HTTP API settings (flat env: LIVEKIT_*).</summary>
public sealed class LiveKitOptions
{
    public const string SectionName = "LiveKit";

    /// <summary>Internal HTTP base for Twirp (e.g. http://livekit:7880).</summary>
    public string HttpUrl { get; set; } = "http://livekit:7880";

    public string ApiKey { get; set; } = "devkey";

    /// <summary>Required in all environments that issue join/admin tokens.</summary>
    public string ApiSecret { get; set; } = "";
}
