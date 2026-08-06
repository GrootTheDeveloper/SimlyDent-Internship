namespace LiveKitPoc.Api;

/// <summary>
/// Demo clinic directory. In production this is a users table + hashed passwords.
/// Default password for all demo accounts: <c>Demo@123</c>
/// Clinic membership is server-owned — never accepted from the client.
/// </summary>
public sealed class IdentityRegistry
{
    /// <summary>Shared demo password (hashed at startup).</summary>
    public const string DemoPassword = "Demo@123";

    public const string ClinicA = "clinic-a";
    public const string ClinicB = "clinic-b";

    private readonly Dictionary<string, StoredIdentity> _users =
        new(StringComparer.OrdinalIgnoreCase);

    public IdentityRegistry(AuthTokenService auth)
    {
        void Add(string id, string clinicId, string displayName, string role = IdentityRoles.Staff)
        {
            var identity = new TestIdentity(id, clinicId, displayName, role);
            _users[id] = new StoredIdentity(identity, auth.HashPassword(identity, DemoPassword));
        }

        // Staff — TASK-003 Phase 0/1 (auto-dispatch).
        Add("A1", ClinicA, "Nguyễn Minh Anh");
        Add("A2", ClinicA, "Trần Thu Hà");
        Add("A3", ClinicA, "Lê Quốc Bảo");
        Add("B1", ClinicB, "Phạm Ngọc Lan");

        // Managers — Phase 3 recording ACL (never auto-dispatched).
        Add("A-MGR", ClinicA, "Quản lý phòng khám A", IdentityRoles.Manager);
        Add("B-MGR", ClinicB, "Quản lý phòng khám B", IdentityRoles.Manager);

        // Visitors — Phase 1 queue path (not listed in staff directory).
        Add("VA", ClinicA, "Visitor Clinic A", IdentityRoles.Visitor);
        Add("VB", ClinicB, "Visitor Clinic B", IdentityRoles.Visitor);

        // Synthetic identities for concurrent API/capacity tests (hidden from default directory).
        var loadCount = 40;
        if (int.TryParse(Environment.GetEnvironmentVariable("LOAD_TEST_USER_COUNT"), out var configured)
            && configured >= 0)
        {
            loadCount = Math.Min(configured, 200);
        }
        for (var i = 1; i <= loadCount; i++)
        {
            var id = $"L{i:D2}";
            Add(id, ClinicA, $"Load User {i:D2}");
        }
    }

    public IReadOnlyCollection<TestIdentity> All =>
        _users.Values.Select(u => u.Identity).ToArray();

    /// <summary>Login picker: staff + visitors (excludes load-test users).</summary>
    public IReadOnlyCollection<TestIdentity> Directory(bool includeLoadUsers = false) =>
        _users.Values
            .Select(u => u.Identity)
            .Where(u => includeLoadUsers || !IsLoadTestUser(u.Id))
            .ToArray();

    /// <summary>
    /// Staff + Manager directory for messenger UI (excludes visitors and load users by default).
    /// Dispatch still filters Role==Staff only.
    /// </summary>
    public IReadOnlyCollection<TestIdentity> DirectoryForClinic(
        string clinicId,
        bool includeLoadUsers = false,
        bool includeVisitors = false) =>
        Directory(includeLoadUsers)
            .Where(u => string.Equals(u.ClinicId, clinicId, StringComparison.OrdinalIgnoreCase))
            .Where(u =>
            {
                if (includeVisitors) return true;
                return u.Role is IdentityRoles.Staff or IdentityRoles.Manager;
            })
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
        var auth = new PasswordProbe();
        if (!auth.Verify(row.Identity, row.PasswordHash, password))
            return false;
        identity = row.Identity;
        return true;
    }

    private sealed record StoredIdentity(TestIdentity Identity, string PasswordHash);

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
