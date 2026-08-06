# Measured capacity summary — 2026-08-06

**Host:** GROOTTHEDEVELOP (Windows + Docker Desktop), not VPS GOLD4.  
**Stack:** local `docker-compose` LiveKit 1.13.1 + backend JWT + synthetic users L01–L40.  
**Suite report:** [suite-20260806-012557](suite-20260806-012557/SUMMARY.md)  
**Ceiling probes:** [api-ceiling-20260806](api-ceiling-20260806/SUMMARY.md), [media-ceiling-20260806](media-ceiling-20260806/SUMMARY.md)

## API / signaling (JWT call lifecycle)

Ladder: concurrent pairs create → accept → token → hold → end.

| Concurrent pairs | Success | Wall ≈ hold+overhead | Notes |
|---:|---:|---|---|
| 1–8 | 100% | ~6.3 s (hold 6s) | Suite default ladder |
| 10 | 100% | ~5.5 s (hold 5s) | Ceiling probe |
| 15 | 100% | ~5.6 s | |
| **20** | **100%** | ~5.7 s | Max synthetic pairs (L01–L40) |

- **Busy rule:** PASS (third party → busy user = HTTP 409).  
- Backend/LiveKit CPU during API-only hold ≈ idle (signaling is cheap).  
- **Conclusion (this host):** App path supports **≥20 concurrent 1:1 sessions** for signaling/token. Not the media bottleneck.

## Media SFU (CLI `lk load-test`, 2 video publishers / room)

| Concurrent rooms (= 1:1 calls) | Publishers | Duration | Success | LiveKit CPU peak (docker stats) | LiveKit mem |
|---:|---:|---:|---:|---:|---|
| 1 | 2 | 30s | 100% | ~6% | ~55 MiB |
| 2 | 2 | 30s | 100% | ~7% | ~55 MiB |
| 3 | 2 | 30s | 100% | ~27% | ~57 MiB |
| 5 | 2 | 30s | 100% | ~39% | ~57 MiB |
| 8 | 2 | 25s | 100% | **~79%** | ~61 MiB |
| **10** | 2 | 25s | 100% | **~97%** | ~61 MiB |

- Topology note: CLI publishers ≠ browser encode; SFU forward + host docker is what we measured.  
- **Conclusion (this host):** **10 simultaneous HD-ish rooms still complete**, but LiveKit container CPU peak approaches **100%** → practical comfort zone closer to **~5–8** concurrent media rooms before quality risk; **10 = stress ceiling** on this laptop Docker host.

## How to re-run

```powershell
.\scripts\run-capacity-suite.ps1 -ApiLevels "1,2,3,5,8" -MediaRooms "1,2,3,5"
.\scripts\api-load-test.ps1 -ConcurrentLevels "10,15,20" -HoldSeconds 5
.\scripts\media-load-test.ps1 -ConcurrentRooms "8,10" -DurationSeconds 25
```

On **VPS 2 vCPU / 4 GB**, re-run the same suite — expect lower media ceiling (especially with TURN + recording).

## Caveats for stakeholders

1. Not a production SLA; single host, short duration (25–30 s media, 5–6 s API hold).  
2. No browser camera path, no multi-network TURN share in this run.  
3. Recording (Egress) not included — treat recording as **+1 heavy job**, separate budget.  
4. Sustained 5‑minute human call still follows [docs/performance-test-plan.md](../../docs/performance-test-plan.md).
