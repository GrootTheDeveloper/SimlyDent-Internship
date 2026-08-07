using System.Globalization;
using System.Net.Http.Headers;
using System.Text;

namespace LiveKitPoc.Api;

public interface IRecordingStorage
{
    string BackendName { get; }

    /// <summary>True when CreatePresignedGetUrl can return a browser-usable URL.</summary>
    bool SupportsPresignedGet { get; }

    /// <summary>Server-owned key: clinic/{clinicId}/calls/{callId}/{recordingId}.{ext}</summary>
    string BuildKey(string clinicId, Guid callId, string recordingId, string extension);

    Task SaveFromLocalFileAsync(string storageKey, string localPath, CancellationToken ct);

    Task<Stream?> OpenReadAsync(string storageKey, CancellationToken ct);

    Task<bool> ExistsAsync(string storageKey, CancellationToken ct);

    Task DeleteAsync(string storageKey, CancellationToken ct);

    /// <summary>Local filesystem path when backend is local; null for remote-only.</summary>
    string? TryGetLocalPath(string storageKey);

    /// <summary>
    /// SigV4 presigned GET against the public endpoint host (browser-reachable).
    /// Null if unsupported. Never log the returned URL.
    /// </summary>
    string? CreatePresignedGetUrl(string storageKey, TimeSpan ttl);
}

public static class RecordingStorageKeys
{
    public static string Build(string clinicId, Guid callId, string recordingId, string extension)
    {
        var ext = extension.TrimStart('.');
        var clinic = Sanitize(clinicId);
        var rec = Sanitize(recordingId);
        return $"clinic/{clinic}/calls/{callId:N}/{rec}.{ext}";
    }

    private static string Sanitize(string value)
    {
        var chars = value.Trim().Select(ch =>
            char.IsLetterOrDigit(ch) || ch is '-' or '_' ? ch : '-').ToArray();
        return new string(chars).ToLowerInvariant();
    }
}

/// <summary>Disk under RECORDINGS_PATH with clinic-scoped relative keys.</summary>
public sealed class LocalRecordingStorage : IRecordingStorage
{
    private readonly string _root;

    public LocalRecordingStorage(IConfiguration configuration)
    {
        _root = configuration["RECORDINGS_PATH"] ?? "/recordings";
        Directory.CreateDirectory(_root);
    }

    public string BackendName => "local";
    public bool SupportsPresignedGet => false;

    public string BuildKey(string clinicId, Guid callId, string recordingId, string extension) =>
        RecordingStorageKeys.Build(clinicId, callId, recordingId, extension);

    public string? TryGetLocalPath(string storageKey) => ResolvePath(storageKey);

    public string? CreatePresignedGetUrl(string storageKey, TimeSpan ttl) => null;

    public Task SaveFromLocalFileAsync(string storageKey, string localPath, CancellationToken ct)
    {
        var dest = ResolvePath(storageKey);
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        if (!string.Equals(Path.GetFullPath(localPath), Path.GetFullPath(dest), StringComparison.OrdinalIgnoreCase))
            File.Copy(localPath, dest, overwrite: true);
        return Task.CompletedTask;
    }

    public Task<Stream?> OpenReadAsync(string storageKey, CancellationToken ct)
    {
        var path = ResolvePath(storageKey);
        if (!File.Exists(path)) return Task.FromResult<Stream?>(null);
        Stream s = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Task.FromResult<Stream?>(s);
    }

    public Task<bool> ExistsAsync(string storageKey, CancellationToken ct) =>
        Task.FromResult(File.Exists(ResolvePath(storageKey)));

    public Task DeleteAsync(string storageKey, CancellationToken ct)
    {
        var path = ResolvePath(storageKey);
        if (File.Exists(path))
            File.Delete(path);
        return Task.CompletedTask;
    }

    private string ResolvePath(string storageKey)
    {
        var normalized = storageKey.Replace('\\', '/').TrimStart('/');
        if (normalized.Contains("..", StringComparison.Ordinal))
            throw new InvalidOperationException("Invalid storage key.");
        var full = Path.GetFullPath(Path.Combine(_root, normalized.Replace('/', Path.DirectorySeparatorChar)));
        var rootFull = Path.GetFullPath(_root);
        if (!full.StartsWith(rootFull, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Storage key escapes root.");
        return full;
    }
}

/// <summary>
/// S3-compatible client (MinIO fixture / any SigV4 S3).
/// Internal endpoint: Head/Put/Delete from API.
/// Public endpoint: presigned GET host (must be browser-reachable; same bucket/objects).
/// </summary>
public sealed class S3RecordingStorage : IRecordingStorage
{
    private readonly HttpClient _http;
    private readonly string _internalEndpoint;
    private readonly string _publicEndpoint;
    private readonly string _bucket;
    private readonly string _accessKey;
    private readonly string _secretKey;
    private readonly string _region;
    private readonly bool _pathStyle;

    public S3RecordingStorage(IConfiguration configuration, IHttpClientFactory httpClientFactory)
    {
        _http = httpClientFactory.CreateClient(nameof(S3RecordingStorage));
        // Prefer explicit split; fall back to legacy S3_ENDPOINT for both if only one set.
        var legacy = (configuration["S3_ENDPOINT"] ?? "http://minio:9000").TrimEnd('/');
        _internalEndpoint = (configuration["S3_INTERNAL_ENDPOINT"] ?? legacy).TrimEnd('/');
        _publicEndpoint = (configuration["S3_PUBLIC_ENDPOINT"] ?? configuration["S3_ENDPOINT"] ?? "").TrimEnd('/');
        _bucket = configuration["S3_BUCKET"] ?? "simlydent-recordings";
        _accessKey = configuration["S3_ACCESS_KEY"] ?? "minioadmin";
        _secretKey = configuration["S3_SECRET_KEY"] ?? "minioadmin";
        _region = configuration["S3_REGION"] ?? "us-east-1";
        _pathStyle = !string.Equals(configuration["S3_PATH_STYLE"], "0", StringComparison.OrdinalIgnoreCase);
    }

    public string BackendName => "s3";

    public bool SupportsPresignedGet =>
        !string.IsNullOrWhiteSpace(_publicEndpoint)
        && Uri.TryCreate(_publicEndpoint, UriKind.Absolute, out var u)
        && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp);

    public string BuildKey(string clinicId, Guid callId, string recordingId, string extension) =>
        RecordingStorageKeys.Build(clinicId, callId, recordingId, extension);

    public string? TryGetLocalPath(string storageKey) => null;

    public async Task SaveFromLocalFileAsync(string storageKey, string localPath, CancellationToken ct)
    {
        await using var fs = File.OpenRead(localPath);
        using var content = new StreamContent(fs);
        content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
        var req = await SignedRequestAsync(HttpMethod.Put, storageKey, content, _internalEndpoint, ct);
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException($"S3 PutObject failed HTTP {(int)res.StatusCode}: {body}");
        }
    }

    public async Task<Stream?> OpenReadAsync(string storageKey, CancellationToken ct)
    {
        var req = await SignedRequestAsync(HttpMethod.Get, storageKey, null, _internalEndpoint, ct);
        var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
        if (res.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            res.Dispose();
            return null;
        }
        if (!res.IsSuccessStatusCode)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            res.Dispose();
            throw new InvalidOperationException($"S3 GetObject failed HTTP {(int)res.StatusCode}: {body}");
        }
        return await res.Content.ReadAsStreamAsync(ct);
    }

    public async Task<bool> ExistsAsync(string storageKey, CancellationToken ct)
    {
        var req = await SignedRequestAsync(HttpMethod.Head, storageKey, null, _internalEndpoint, ct);
        using var res = await _http.SendAsync(req, ct);
        return res.IsSuccessStatusCode;
    }

    public async Task DeleteAsync(string storageKey, CancellationToken ct)
    {
        var req = await SignedRequestAsync(HttpMethod.Delete, storageKey, null, _internalEndpoint, ct);
        using var res = await _http.SendAsync(req, ct);
        if (!res.IsSuccessStatusCode && res.StatusCode != System.Net.HttpStatusCode.NotFound)
        {
            var body = await res.Content.ReadAsStringAsync(ct);
            throw new InvalidOperationException($"S3 DeleteObject failed HTTP {(int)res.StatusCode}: {body}");
        }
    }

    public string? CreatePresignedGetUrl(string storageKey, TimeSpan ttl)
    {
        if (!SupportsPresignedGet)
            return null;
        if (ttl <= TimeSpan.Zero) ttl = TimeSpan.FromMinutes(5);
        if (ttl > TimeSpan.FromMinutes(15)) ttl = TimeSpan.FromMinutes(15);

        var objectKey = storageKey.Replace('\\', '/').TrimStart('/');
        var endpoint = _publicEndpoint;
        var uriBase = new Uri(endpoint + "/");
        var hostHeader = uriBase.IsDefaultPort
            ? uriBase.Host
            : $"{uriBase.Host}:{uriBase.Port}";

        var now = DateTime.UtcNow;
        var amzDate = now.ToString("yyyyMMddTHHmmssZ");
        var dateStamp = now.ToString("yyyyMMdd");
        var expires = Math.Max(1, (int)ttl.TotalSeconds);
        var credentialScope = $"{dateStamp}/{_region}/s3/aws4_request";
        var credential = $"{_accessKey}/{credentialScope}";

        var canonicalUri = _pathStyle
            ? $"/{_bucket}/{EncodeS3Key(objectKey)}"
            : $"/{EncodeS3Key(objectKey)}";

        // Query params must be sorted for canonical request.
        var query = new SortedDictionary<string, string>(StringComparer.Ordinal)
        {
            ["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256",
            ["X-Amz-Credential"] = credential,
            ["X-Amz-Date"] = amzDate,
            ["X-Amz-Expires"] = expires.ToString(CultureInfo.InvariantCulture),
            ["X-Amz-SignedHeaders"] = "host"
        };

        var canonicalQuery = string.Join("&",
            query.Select(kv => $"{Uri.EscapeDataString(kv.Key)}={Uri.EscapeDataString(kv.Value)}"));

        var canonicalHeaders = $"host:{hostHeader}\n";
        var signedHeaders = "host";
        var payloadHash = "UNSIGNED-PAYLOAD";
        var canonicalRequest = string.Join("\n",
            "GET",
            canonicalUri,
            canonicalQuery,
            canonicalHeaders,
            signedHeaders,
            payloadHash);

        var stringToSign = string.Join("\n",
            "AWS4-HMAC-SHA256",
            amzDate,
            credentialScope,
            Sha256Hex(canonicalRequest));

        var signingKey = GetSignatureKey(_secretKey, dateStamp, _region, "s3");
        var signature = ToHex(HmacSha256(signingKey, stringToSign));

        var url = _pathStyle
            ? $"{endpoint}/{_bucket}/{objectKey}?{canonicalQuery}&X-Amz-Signature={signature}"
            : $"{endpoint}/{objectKey}?{canonicalQuery}&X-Amz-Signature={signature}";
        return url;
    }

    private Task<HttpRequestMessage> SignedRequestAsync(
        HttpMethod method,
        string key,
        HttpContent? content,
        string endpoint,
        CancellationToken ct)
    {
        var objectKey = key.Replace('\\', '/').TrimStart('/');
        var url = _pathStyle
            ? $"{endpoint}/{_bucket}/{objectKey}"
            : $"{endpoint}/{objectKey}";
        var uri = new Uri(url);
        var request = new HttpRequestMessage(method, uri) { Content = content };
        SignAwsV4Header(request, objectKey);
        return Task.FromResult(request);
    }

    private void SignAwsV4Header(HttpRequestMessage request, string objectKey)
    {
        var now = DateTime.UtcNow;
        var amzDate = now.ToString("yyyyMMddTHHmmssZ");
        var dateStamp = now.ToString("yyyyMMdd");
        var payloadHash = "UNSIGNED-PAYLOAD";
        request.Headers.Host = request.RequestUri!.Host +
            (request.RequestUri.IsDefaultPort ? "" : ":" + request.RequestUri.Port);
        request.Headers.TryAddWithoutValidation("x-amz-date", amzDate);
        request.Headers.TryAddWithoutValidation("x-amz-content-sha256", payloadHash);

        var canonicalUri = _pathStyle
            ? $"/{_bucket}/{EncodeS3Key(objectKey)}"
            : $"/{EncodeS3Key(objectKey)}";

        var canonicalHeaders = $"host:{request.Headers.Host}\nx-amz-content-sha256:{payloadHash}\nx-amz-date:{amzDate}\n";
        var signedHeaders = "host;x-amz-content-sha256;x-amz-date";
        var canonicalRequest = string.Join("\n",
            request.Method.Method,
            canonicalUri,
            "",
            canonicalHeaders,
            signedHeaders,
            payloadHash);

        var algorithm = "AWS4-HMAC-SHA256";
        var credentialScope = $"{dateStamp}/{_region}/s3/aws4_request";
        var stringToSign = string.Join("\n",
            algorithm,
            amzDate,
            credentialScope,
            Sha256Hex(canonicalRequest));

        var signingKey = GetSignatureKey(_secretKey, dateStamp, _region, "s3");
        var signature = ToHex(HmacSha256(signingKey, stringToSign));
        var auth =
            $"{algorithm} Credential={_accessKey}/{credentialScope}, SignedHeaders={signedHeaders}, Signature={signature}";
        request.Headers.TryAddWithoutValidation("Authorization", auth);
    }

    private static string EncodeS3Key(string key) =>
        string.Join("/", key.Split('/').Select(s => Uri.EscapeDataString(s).Replace("%2F", "/")));

    private static byte[] HmacSha256(byte[] key, string data)
    {
        using var h = new System.Security.Cryptography.HMACSHA256(key);
        return h.ComputeHash(Encoding.UTF8.GetBytes(data));
    }

    private static byte[] GetSignatureKey(string key, string dateStamp, string regionName, string serviceName)
    {
        var kDate = HmacSha256(Encoding.UTF8.GetBytes("AWS4" + key), dateStamp);
        var kRegion = HmacSha256(kDate, regionName);
        var kService = HmacSha256(kRegion, serviceName);
        return HmacSha256(kService, "aws4_request");
    }

    private static string Sha256Hex(string data)
    {
        var hash = System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(data));
        return ToHex(hash);
    }

    private static string ToHex(byte[] bytes)
    {
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (var b in bytes) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }
}

public static class RecordingStorageFactory
{
    public static IRecordingStorage Create(IServiceProvider sp)
    {
        var config = sp.GetRequiredService<IConfiguration>();
        var backend = (config["RECORDING_STORAGE"] ?? "local").Trim().ToLowerInvariant();
        if (backend is "s3" or "minio")
            return ActivatorUtilities.CreateInstance<S3RecordingStorage>(sp);
        return ActivatorUtilities.CreateInstance<LocalRecordingStorage>(sp);
    }
}
