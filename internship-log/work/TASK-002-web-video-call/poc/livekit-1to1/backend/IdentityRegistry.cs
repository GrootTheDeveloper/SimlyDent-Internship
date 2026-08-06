namespace LiveKitPoc.Api;

/// <summary>
/// Demo clinic directory. In production this is a users table + hashed passwords.
/// Default password for all demo accounts: <c>Demo@123</c>
/// </summary>
public sealed class IdentityRegistry
{
    /// <summary>Shared demo password (hashed at startup).</summary>
    public const string DemoPassword = "Demo@123";

    private readonly Dictionary<string, StoredIdentity> _users =
        new(StringComparer.OrdinalIgnoreCase);

    public IdentityRegistry(AuthTokenService auth)
    {
        void Add(string id, string tenantId, string displayName)
        {
            var identity = new TestIdentity(id, tenantId, displayName);
            _users[id] = new StoredIdentity(identity, auth.HashPassword(identity, DemoPassword));
        }

        Add("A1", "tenant-a", "Nguyễn Minh Anh");
        Add("A2", "tenant-a", "Trần Thu Hà");
        Add("A3", "tenant-a", "Lê Quốc Bảo");
        Add("B1", "tenant-b", "Phạm Ngọc Lan");

        // Synthetic identities for concurrent API/capacity tests (hidden from default directory).
        // L01..L40 → up to 20 simultaneous 1:1 pairs in tenant-a.
        var loadCount = 40;
        if (int.TryParse(Environment.GetEnvironmentVariable("LOAD_TEST_USER_COUNT"), out var configured)
            && configured >= 0)
        {
            loadCount = Math.Min(configured, 200);
        }
        for (var i = 1; i <= loadCount; i++)
        {
            var id = $"L{i:D2}";
            Add(id, "tenant-a", $"Load User {i:D2}");
        }
    }

    public IReadOnlyCollection<TestIdentity> All =>
        _users.Values.Select(u => u.Identity).ToArray();

    /// <summary>Clinic directory for UI. Excludes synthetic load-test users (Lxx) by default.</summary>
    public IReadOnlyCollection<TestIdentity> Directory(bool includeLoadUsers = false) =>
        _users.Values
            .Select(u => u.Identity)
            .Where(u => includeLoadUsers || !IsLoadTestUser(u.Id))
            .ToArray();

    public static bool IsLoadTestUser(string? id) =>
        id is not null
        && id.Length >= 3
        && (id[0] is 'L' or 'l')
        && char.IsDigit(id[1]);

    public TestIdentity? Find(string? id) =>
        id is not null && _users.TryGetValue(id, out var row) ? row.Identity : null;

    public bool TryAuthenticate(string? userId, string? password, out TestIdentity? identity)
    {
        identity = null;
        if (string.IsNullOrWhiteSpace(userId) || string.IsNullOrEmpty(password))
            return false;
        if (!_users.TryGetValue(userId, out var row))
            return false;
        // PasswordHasher needs the same user object shape; verify with stored identity.
        var auth = new PasswordProbe();
        if (!auth.Verify(row.Identity, row.PasswordHash, password))
            return false;
        identity = row.Identity;
        return true;
    }

    private sealed record StoredIdentity(TestIdentity Identity, string PasswordHash);

    /// <summary>Thin wrapper so IdentityRegistry does not re-enter AuthTokenService circular ctor.</summary>
    private sealed class PasswordProbe
    {
        private readonly Microsoft.AspNetCore.Identity.PasswordHasher<TestIdentity> _hasher = new();

        public bool Verify(TestIdentity user, string hash, string password)
        {
            var result = _hasher.VerifyHashedPassword(user, hash, password);
            return result is Microsoft.AspNetCore.Identity.PasswordVerificationResult.Success
                or Microsoft.AspNetCore.Identity.PasswordVerificationResult.SuccessRehashNeeded;
        }
    }
}
