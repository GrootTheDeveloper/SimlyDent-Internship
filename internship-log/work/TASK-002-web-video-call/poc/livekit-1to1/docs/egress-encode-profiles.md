# Egress encode profiles (R-enc)

Room Composite recording bitrate is controlled by ASP.NET → LiveKit `StartRoomCompositeEgress`.

## Modes

| `EGRESS_ENCODING_MODE` | Behaviour |
|------------------------|-----------|
| `preset` (default) | Uses LiveKit named preset via `EGRESS_VIDEO_PRESET` |
| `advanced` | Custom width/height/fps + video/audio bitrate (kbps) |

## Environment variables

| Variable | Default | Notes |
|----------|---------|--------|
| `EGRESS_ENCODING_MODE` | `preset` | `preset` \| `advanced` |
| `EGRESS_VIDEO_PRESET` | `H264_720P_30` | LiveKit preset name when mode=preset |
| `EGRESS_WIDTH` | `1280` | advanced only |
| `EGRESS_HEIGHT` | `720` | Prefer keep 720p for dental detail |
| `EGRESS_FRAMERATE` | `20` | advanced; try 20 before dropping resolution |
| `EGRESS_VIDEO_BITRATE_KBPS` | `1500` | LiveKit `videoBitrate` unit is **kbps** |
| `EGRESS_AUDIO_BITRATE_KBPS` | `96` | LiveKit `audioBitrate` unit is **kbps** |
| `EGRESS_KEY_FRAME_INTERVAL` | `2` | seconds (optional) |

## Recommended trial matrix (clinical 1:1)

Keep **720p**; reduce FPS/bitrate before 480p.

| Profile | Mode | Settings | Rough size guide |
|---------|------|----------|------------------|
| Baseline PoC | preset | `H264_720P_30` | ~1.0–1.3 GB/h (order of magnitude) |
| Economy A | advanced | 1280×720 @ 20fps, **1200** kbps + 96 kbps audio | conditional ~0.55–0.65 GB/h |
| Economy B | advanced | 1280×720 @ 20fps, **1500** kbps + 96 kbps audio | conditional ~0.6–0.7 GB/h |
| Quality | advanced | 1280×720 @ 20–30fps, **2000** kbps + 96 kbps audio | larger; use if detail fails QA |

**~0.55–0.7 GB/h is a conditional target**, not a hard gate. Choose the lowest bitrate that still passes subjective visual acceptance.

### Scenarios to record when benchmarking

1. Talking-head, little motion  
2. Hand/head motion  
3. Camera close-up of clinical detail  
4. Fluctuating network / resolution switch  

### Metrics to capture

- File size / hour (or size ÷ duration)  
- Egress container CPU during call  
- Finalize latency (stop → Ready)  
- Actual fps/resolution if available from tools  
- Subjective pass/fail for clinical review  

## Example VPS `.env` snippet (economy trial)

```bash
EGRESS_ENCODING_MODE=advanced
EGRESS_WIDTH=1280
EGRESS_HEIGHT=720
EGRESS_FRAMERATE=20
EGRESS_VIDEO_BITRATE_KBPS=1500
EGRESS_AUDIO_BITRATE_KBPS=96
```

Restart gateway after changing env:

```bash
docker compose -f docker-compose.vps.yml up -d gateway --force-recreate
```

## Code

- `backend/LiveKitEgressService.cs` → `ApplyVideoEncodingOptions`
- Compose: `docker-compose.yml`, `docker-compose.vps.yml`
