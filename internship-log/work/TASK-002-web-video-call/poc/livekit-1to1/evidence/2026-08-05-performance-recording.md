# Performance and recording evidence - 2026-08-05

## Video quality configuration

- Camera target: 1280x720 at 30 fps.
- Codec: VP8 for browser publish compatibility.
- Simulcast: enabled.
- Subscriber preference: HIGH.
- Degradation preference: maintain resolution.
- Maximum publish bitrate: 2.5 Mbps.
- Runtime panel: incoming/outgoing resolution, fps, bitrate, packet loss, jitter, RTT, codec and browser limitation reason.

Earlier device logs showed that the iPhone published 720x1280 with LOW 180x320, MEDIUM 360x640 and HIGH 720x1280 layers. The quality change targets subscriber layer selection; it does not increase the camera source above 720p.

## Recording test

- LiveKit Server: 1.13.1.
- LiveKit Egress: 1.12.0.
- Redis: 7.4.
- Input: official LiveKit CLI demo publisher with a 720p simulcast video.
- Start/stop/finalize: pass.
- Local MP4 write: pass.
- Authorized download: HTTP 200.
- Cross-tenant download: HTTP 404.
- Output video: H.264, 1280x720, 30 fps.
- Output audio: AAC.
- Measured sample: 9.218 seconds, 3,343,533 bytes.

Commands:

```powershell
.\scripts\smoke-test.ps1
.\scripts\recording-e2e-test.ps1
```

Application/security smoke result after the change: 17/17 pass.

## Open qualification items

- Repeat the A/B call on the laptop and iPhone and capture the new runtime quality panel on both sides.
- Run the same call from two different networks after production ingress and TURN are available.
- Define recording consent, retention, encryption and audit policy before production use.
