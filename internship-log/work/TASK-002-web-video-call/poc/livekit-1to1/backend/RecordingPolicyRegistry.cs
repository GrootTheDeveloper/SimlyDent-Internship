namespace LiveKitPoc.Api;

/// <summary>
/// Clinic recording policy. Default/fail-safe is always <see cref="RecordingMode.None"/>.
/// </summary>
public sealed class RecordingPolicyRegistry
{
    private readonly Dictionary<string, RecordingPolicy> _byClinic =
        new(StringComparer.OrdinalIgnoreCase);

    public RecordingPolicyRegistry(IConfiguration configuration)
    {
        var defaultRetention = int.TryParse(configuration["RECORDING_RETENTION_DAYS"], out var d)
            ? Math.Clamp(d, 1, 3650)
            : 30;

        void Put(string clinicId, RecordingMode defaultMode)
        {
            _byClinic[clinicId] = new RecordingPolicy
            {
                ClinicId = clinicId,
                DefaultMode = defaultMode,
                AllowedModes = new[]
                {
                    RecordingMode.None,
                    RecordingMode.AudioOnly,
                    RecordingMode.Video
                },
                RequireConsent = true,
                RetentionDays = defaultRetention,
                Version = configuration["RECORDING_POLICY_VERSION"] ?? "1"
            };
        }

        // Fail-safe: missing clinic → None via Get().
        Put(IdentityRegistry.ClinicA, RecordingMode.None);
        Put(IdentityRegistry.ClinicB, RecordingMode.None);

        // Optional overrides: RECORDING_DEFAULT_MODE_CLINIC_A=Video etc.
        ApplyOverride(configuration, IdentityRegistry.ClinicA, "RECORDING_DEFAULT_MODE_CLINIC_A");
        ApplyOverride(configuration, IdentityRegistry.ClinicB, "RECORDING_DEFAULT_MODE_CLINIC_B");
    }

    private void ApplyOverride(IConfiguration configuration, string clinicId, string envKey)
    {
        var raw = configuration[envKey];
        if (string.IsNullOrWhiteSpace(raw)) return;
        if (!Enum.TryParse<RecordingMode>(raw.Trim(), ignoreCase: true, out var mode))
            return;
        if (!_byClinic.TryGetValue(clinicId, out var existing)) return;
        _byClinic[clinicId] = new RecordingPolicy
        {
            ClinicId = clinicId,
            DefaultMode = mode,
            AllowedModes = existing.AllowedModes,
            RequireConsent = existing.RequireConsent,
            RetentionDays = existing.RetentionDays,
            Version = existing.Version
        };
    }

    public RecordingPolicy Get(string clinicId)
    {
        if (_byClinic.TryGetValue(clinicId, out var p))
            return p;
        return new RecordingPolicy
        {
            ClinicId = clinicId,
            DefaultMode = RecordingMode.None,
            AllowedModes = new[]
            {
                RecordingMode.None,
                RecordingMode.AudioOnly,
                RecordingMode.Video
            },
            RequireConsent = true,
            RetentionDays = 30,
            Version = "1"
        };
    }
}
