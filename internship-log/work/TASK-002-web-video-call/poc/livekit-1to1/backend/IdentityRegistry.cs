namespace LiveKitPoc.Api;

public sealed class IdentityRegistry
{
    private static readonly IReadOnlyDictionary<string, TestIdentity> Identities =
        new Dictionary<string, TestIdentity>(StringComparer.OrdinalIgnoreCase)
        {
            ["A1"] = new("A1", "tenant-a", "Nguyễn Minh Anh"),
            ["A2"] = new("A2", "tenant-a", "Trần Thu Hà"),
            ["A3"] = new("A3", "tenant-a", "Lê Quốc Bảo"),
            ["B1"] = new("B1", "tenant-b", "Phạm Ngọc Lan")
        };

    public IReadOnlyCollection<TestIdentity> All { get; } = Identities.Values.ToArray();

    public TestIdentity? Find(string? id) =>
        id is not null && Identities.TryGetValue(id, out var identity) ? identity : null;
}
