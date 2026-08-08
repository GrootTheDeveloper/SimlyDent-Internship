using LiveKitPoc.Api.Options;
using Microsoft.Extensions.Options;
using Xunit;

namespace LiveKitPoc.Api.Tests;

public class DentalEncodingProfileSelectorTests
{
    private static DentalEncodingProfileSelector Create(DentalVideoOptions? o = null)
    {
        o ??= new DentalVideoOptions();
        o.ValidateOrThrow();
        return new DentalEncodingProfileSelector(
            Microsoft.Extensions.Options.Options.Create(o));
    }

    [Fact]
    public void Select_640x480_DoesNotUpscale()
    {
        var p = Create().Select(640, 480, 30);
        Assert.True(p.Width <= 640);
        Assert.True(p.Height <= 480);
        Assert.Equal(480, p.Height); // even
        Assert.True(p.UsedAdvanced);
        Assert.True(p.VideoBitrateKbps <= 1000); // 480p tier, not 720p
    }

    [Fact]
    public void Select_720p20_DoesNotFake30Fps()
    {
        var p = Create().Select(1280, 720, 20);
        Assert.Equal(1280, p.Width);
        Assert.Equal(720, p.Height);
        Assert.Equal(20, p.FrameRate);
        Assert.Equal(1400, p.VideoBitrateKbps);
    }

    [Fact]
    public void Select_Portrait_PreservesOrientation()
    {
        var p = Create().Select(720, 1280, 30);
        Assert.True(p.Height > p.Width);
        Assert.True(p.Width <= 720);
        Assert.True(p.Height <= 1280);
    }

    [Fact]
    public void Select_UnknownMetadata_UsesFallbackOptions()
    {
        var o = new DentalVideoOptions
        {
            FallbackWidth = 960,
            FallbackHeight = 540,
            FallbackFps = 15
        };
        var p = Create(o).Select(null, null, null);
        Assert.Equal(960, p.Width);
        Assert.Equal(540, p.Height);
        Assert.Equal(15, p.FrameRate);
    }

    [Fact]
    public void Select_EvenDimensions()
    {
        var p = Create().Select(641, 481, 25);
        Assert.Equal(0, p.Width % 2);
        Assert.Equal(0, p.Height % 2);
    }

    [Fact]
    public void Select_360p_UsesLowerTier()
    {
        var p = Create().Select(320, 240, 10);
        Assert.True(p.Width <= 320);
        Assert.True(p.Height <= 240);
        Assert.Equal(600, p.VideoBitrateKbps);
    }

    [Fact]
    public void SelectLegacy_UsesPresetFlag()
    {
        var p = Create().SelectLegacy720p30();
        Assert.False(p.UsedAdvanced);
        Assert.Equal(1280, p.Width);
        Assert.Equal(720, p.Height);
        Assert.Equal(30, p.FrameRate);
        Assert.Equal(1800, p.VideoBitrateKbps);
    }

    [Fact]
    public void Options_InvalidMinMax_Throws()
    {
        var o = new DentalVideoOptions { MinBitrateKbps = 3000, MaxBitrateKbps = 1000 };
        Assert.Throws<InvalidOperationException>(() => o.ValidateOrThrow());
    }

    [Fact]
    public void Options_InvalidPreset_Throws()
    {
        var o = new DentalVideoOptions { OptimizePreset = "turbo-not-real" };
        Assert.Throws<InvalidOperationException>(() => o.ValidateOrThrow());
    }
}
