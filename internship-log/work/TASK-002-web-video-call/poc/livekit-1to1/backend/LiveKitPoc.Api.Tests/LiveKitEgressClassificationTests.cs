using System.Net;
using System.Text;
using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using Xunit;

namespace LiveKitPoc.Api.Tests;

public class LiveKitEgressClassificationTests
{
    [Theory]
    [InlineData(400, "invalid_argument", LiveKitEgressErrorClass.RequestRejected, true)]
    [InlineData(422, null, LiveKitEgressErrorClass.RequestRejected, true)]
    [InlineData(400, "unimplemented", LiveKitEgressErrorClass.RequestRejected, true)]
    [InlineData(500, null, LiveKitEgressErrorClass.ServerFailure, false)]
    [InlineData(503, null, LiveKitEgressErrorClass.ServerFailure, false)]
    [InlineData(408, null, LiveKitEgressErrorClass.TransportUnknown, false)]
    [InlineData(429, null, LiveKitEgressErrorClass.TransportUnknown, false)]
    [InlineData(401, null, LiveKitEgressErrorClass.Other, false)]
    [InlineData(409, null, LiveKitEgressErrorClass.Other, false)]
    public void ClassifyHttp_And_SafeRetry(
        int status, string? twirp, LiveKitEgressErrorClass expected, bool safeRetry)
    {
        var cls = LiveKitEgressException.ClassifyHttp(status, twirp);
        Assert.Equal(expected, cls);
        var ex = new LiveKitEgressException("StartTrackCompositeEgress", cls, "x", status, twirp, "m");
        Assert.Equal(safeRetry, ex.IsSafeToRetryStartWithDifferentPayload);
    }

    [Fact]
    public void ClassifyTransport_TimeoutAndReset()
    {
        Assert.Equal(LiveKitEgressErrorClass.TransportUnknown,
            LiveKitEgressException.ClassifyTransport(new TaskCanceledException()));
        Assert.Equal(LiveKitEgressErrorClass.TransportUnknown,
            LiveKitEgressException.ClassifyTransport(new HttpRequestException("connection reset")));
        Assert.Equal(LiveKitEgressErrorClass.TransportUnknown,
            LiveKitEgressException.ClassifyTransport(new IOException("broken pipe")));
    }

    [Fact]
    public void BuildHttpException_ParsesTwirp()
    {
        var body = """{"code":"invalid_argument","msg":"advanced options not supported"}""";
        var ex = LiveKitEgressService.BuildHttpException(
            "StartTrackCompositeEgress", HttpStatusCode.BadRequest, body);
        Assert.Equal(LiveKitEgressErrorClass.RequestRejected, ex.Classification);
        Assert.Equal(400, ex.HttpStatus);
        Assert.Equal("invalid_argument", ex.TwirpCode);
        Assert.Contains("not supported", ex.Message);
        Assert.True(ex.IsSafeToRetryStartWithDifferentPayload);
    }

    [Fact]
    public void TryReadTwirp_ParsesCodeAndMsg()
    {
        var (code, msg) = LiveKitEgressService.TryReadTwirp(
            """{"code":"unimplemented","msg":"nope"}""");
        Assert.Equal("unimplemented", code);
        Assert.Equal("nope", msg);
    }

    [Fact]
    public async Task StartTrackComposite_Deterministic400_AllowsSecondCall_ButServiceThrowsOncePerCall()
    {
        // Mock handler: first advanced → 400 invalid_argument; legacy would succeed if called.
        var handler = new SequenceHandler(
            new HttpResponseMessage(HttpStatusCode.BadRequest)
            {
                Content = new StringContent(
                    """{"code":"invalid_argument","msg":"bad advanced"}""",
                    Encoding.UTF8, "application/json")
            },
            new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"egress_id":"EG_legacy","status":"EGRESS_STARTING"}""",
                    Encoding.UTF8, "application/json")
            });
        var svc = CreateEgress(handler);
        var advanced = new DentalEncodeProfile(640, 480, 24, 900, "H264_MAIN", "t", 640, 480, 24, true);

        var ex = await Assert.ThrowsAsync<LiveKitEgressException>(() =>
            svc.StartTrackCompositeRecordingAsync("room", "TR_x", "f.mp4", null, advanced));
        Assert.True(ex.IsSafeToRetryStartWithDifferentPayload);
        Assert.Equal(1, handler.CallCount);

        // Caller (DentalClip) would now call legacy once — simulate:
        var legacy = new DentalEncodeProfile(1280, 720, 30, 1800, "H264_MAIN", "legacy", null, null, null, false);
        var ok = await svc.StartTrackCompositeRecordingAsync("room", "TR_x", "f.mp4", null, legacy);
        Assert.Equal("EG_legacy", ok.EgressId);
        Assert.Equal(2, handler.CallCount);
    }

    [Fact]
    public async Task StartTrackComposite_Timeout_DoesNotImplySafeRetry()
    {
        var handler = new TimeoutHandler();
        var svc = CreateEgress(handler, httpTimeoutMs: 80);
        var advanced = new DentalEncodeProfile(1280, 720, 30, 1800, "H264_MAIN", "t", 1280, 720, 30, true);

        var ex = await Assert.ThrowsAsync<LiveKitEgressException>(() =>
            svc.StartTrackCompositeRecordingAsync("room", "TR_x", "f.mp4", null, advanced));
        Assert.Equal(LiveKitEgressErrorClass.TransportUnknown, ex.Classification);
        Assert.False(ex.IsSafeToRetryStartWithDifferentPayload);
        Assert.Equal(1, handler.CallCount);
    }

    [Fact]
    public async Task StartTrackComposite_5xx_NotSafeRetry()
    {
        var handler = new SequenceHandler(
            new HttpResponseMessage(HttpStatusCode.InternalServerError)
            {
                Content = new StringContent("""{"code":"internal","msg":"boom"}""", Encoding.UTF8, "application/json")
            });
        var svc = CreateEgress(handler);
        var advanced = new DentalEncodeProfile(1280, 720, 30, 1800, "H264_MAIN", "t", null, null, null, true);
        var ex = await Assert.ThrowsAsync<LiveKitEgressException>(() =>
            svc.StartTrackCompositeRecordingAsync("room", "TR_x", "f.mp4", null, advanced));
        Assert.Equal(LiveKitEgressErrorClass.ServerFailure, ex.Classification);
        Assert.False(ex.IsSafeToRetryStartWithDifferentPayload);
        Assert.Equal(1, handler.CallCount);
    }

    [Fact]
    public void BuildTrackCompositeRequest_SourceAware_UsesAdvanced()
    {
        var svc = CreateEgress(new SequenceHandler());
        var encode = new DentalEncodeProfile(640, 480, 24, 900, "H264_MAIN", "sa", 640, 480, 24, true);
        var req = svc.BuildTrackCompositeRequest("r", "TR_1", "clip.mp4", null, encode);
        Assert.True(req.ContainsKey("advanced"));
        Assert.False(req.ContainsKey("preset"));
        var adv = (Dictionary<string, object?>)req["advanced"]!;
        Assert.Equal(640, adv["width"]);
        Assert.Equal(480, adv["height"]);
        Assert.Equal(24, adv["framerate"]);
        Assert.Equal(900, adv["videoBitrate"]);
    }

    [Fact]
    public void BuildTrackCompositeRequest_Legacy_UsesPreset()
    {
        var svc = CreateEgress(new SequenceHandler());
        var encode = new DentalEncodeProfile(1280, 720, 30, 1800, "H264_MAIN", "legacy", null, null, null, false);
        var req = svc.BuildTrackCompositeRequest("r", "TR_1", "clip.mp4", null, encode);
        Assert.True(req.ContainsKey("preset"));
        Assert.Equal("H264_720P_30", req["preset"]);
        Assert.False(req.ContainsKey("advanced"));
    }

    private static LiveKitEgressService CreateEgress(HttpMessageHandler handler, int? httpTimeoutMs = null)
    {
        var http = new HttpClient(handler) { BaseAddress = new Uri("http://livekit.test") };
        if (httpTimeoutMs is > 0)
            http.Timeout = TimeSpan.FromMilliseconds(httpTimeoutMs.Value);
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["EGRESS_OUTPUT"] = "local",
                ["LIVEKIT_HTTP_URL"] = "http://livekit.test"
            })
            .Build();
        var tokens = new LiveKitTokenService(Microsoft.Extensions.Options.Options.Create(new LiveKitOptions
        {
            HttpUrl = "http://livekit.test",
            ApiKey = "devkey",
            ApiSecret = "secretsecretsecretsecretsecret12"
        }));
        return new LiveKitEgressService(
            http,
            Microsoft.Extensions.Options.Options.Create(new LiveKitOptions
            {
                HttpUrl = "http://livekit.test",
                ApiKey = "devkey",
                ApiSecret = "secretsecretsecretsecretsecret12"
            }),
            Microsoft.Extensions.Options.Options.Create(new RecordingRuntimeOptions { RecordingsPath = Path.GetTempPath() }),
            config,
            tokens);
    }

    private sealed class SequenceHandler : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> _responses;
        public int CallCount { get; private set; }

        public SequenceHandler(params HttpResponseMessage[] responses)
        {
            _responses = new Queue<HttpResponseMessage>(responses);
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            CallCount++;
            // CreateRoom may be called first for some paths — TrackComposite does not call EnsureRoom.
            if (_responses.Count == 0)
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent("""{"egress_id":"EG_x"}""", Encoding.UTF8, "application/json")
                });
            }
            return Task.FromResult(_responses.Dequeue());
        }
    }

    private sealed class TimeoutHandler : HttpMessageHandler
    {
        public int CallCount { get; private set; }

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken)
        {
            CallCount++;
            await Task.Delay(Timeout.Infinite, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }
    }
}
