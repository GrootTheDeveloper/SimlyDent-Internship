# VPS capacity run (live)

- When: 2026-08-06T02:36:55Z
- Commit: 563f23e Fix VPS deploy smoke to use JWT login before /api/identities.
- Domain: 103.28.32.118.sslip.io
- Topology media: N rooms × 2 video publishers + 2 subscribers (CLI, not browser cam)
- Note: A1/A2 real call may still be active (extra concurrent load) — OK for stress.

## API concurrent pairs (JWT Lxx)
```
--- API pairs N=1 ---
N=1 ok=1 fail=0 wall_ms=3998
--- API pairs N=3 ---
N=3 ok=3 fail=0 wall_ms=4437
--- API pairs N=5 ---
N=5 ok=5 fail=0 wall_ms=5273
--- API pairs N=8 ---
N=8 ok=8 fail=0 wall_ms=6535
```

## Media SFU rooms
```
--- Media rooms N=1 duration=25s ---
N=1 ok=1 fail=0
livekit-1to1-gateway-1|0.00%|17.91MiB / 3.852GiB
livekit-1to1-frontend-1|0.00%|3.973MiB / 3.852GiB
livekit-1to1-backend-1|0.13%|59.59MiB / 3.852GiB
livekit-1to1-livekit-1|22.47%|74.15MiB / 3.852GiB
livekit-1to1-redis-1|0.84%|4.117MiB / 3.852GiB
--- Media rooms N=3 duration=25s ---
N=3 ok=3 fail=0
livekit-1to1-gateway-1|0.17%|17.91MiB / 3.852GiB
livekit-1to1-frontend-1|0.00%|3.973MiB / 3.852GiB
livekit-1to1-backend-1|0.18%|61.39MiB / 3.852GiB
livekit-1to1-livekit-1|25.21%|100.8MiB / 3.852GiB
livekit-1to1-redis-1|0.85%|4.078MiB / 3.852GiB
--- Media rooms N=5 duration=25s ---
N=5 ok=5 fail=0
livekit-1to1-gateway-1|0.03%|17.91MiB / 3.852GiB
livekit-1to1-frontend-1|0.00%|3.973MiB / 3.852GiB
livekit-1to1-backend-1|0.06%|61.88MiB / 3.852GiB
livekit-1to1-livekit-1|35.13%|137.5MiB / 3.852GiB
livekit-1to1-redis-1|0.83%|4.156MiB / 3.852GiB
```

## Mbps approx (Prometheus, if available)
```
rooms=1 approx_mbps_in=0.000 out=0.000 total=0.000
rooms=3 approx_mbps_in=0.000 out=0.000 total=0.000
rooms=5 approx_mbps_in=0.000 out=0.000 total=0.000
```

Artifacts under: `/opt/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/evidence/capacity-runs/vps-live-20260806-093436`
