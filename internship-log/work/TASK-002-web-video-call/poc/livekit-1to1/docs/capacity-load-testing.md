# Capacity & load testing (automated)

Automated measurement of **API/signaling** concurrency and **LiveKit SFU media** concurrency for the 1:1 PoC.

## Scripts

| Script | What it measures |
|---|---|
| `scripts/api-load-test.ps1` | JWT login → create → accept → token → hold → end, ladder of concurrent pairs (`L01`↔`L02`, …) |
| `scripts/media-load-test.ps1` | N rooms × 2 CLI video publishers + subscribers; **docker stats** + **LiveKit Prometheus** (Mbps in/out, pkt/s, loss%) |
| `scripts/run-capacity-suite.ps1` | Runs both + `combined-report.json` / `SUMMARY.md` |
| `scripts/lib/poc-load-common.ps1` | Shared auth + docker stats helpers |

Outputs land under `evidence/capacity-runs/<prefix>-<timestamp>/`.

## Prerequisites

1. Stack up (`scripts/start.ps1` or existing compose).
2. Backend image includes load users **L01–L40** (default) — rebuild after pulling IdentityRegistry changes.
3. LiveKit CLI `lk` for media tests (same path as recording e2e).
4. Docker CLI for `docker stats` sampling.
5. LiveKit Prometheus: `prometheus_port: 6789` in `infra/livekit.yaml` and host port `6789:6789` (local compose). Scrape `http://localhost:6789/metrics`.

## Quick run

```powershell
cd poc/livekit-1to1

# Full suite (API ladder + media ladder)
.\scripts\run-capacity-suite.ps1

# Faster smoke of the harness
.\scripts\run-capacity-suite.ps1 `
  -ApiLevels "1,2,3" -ApiHoldSeconds 5 `
  -MediaRooms "1,2" -MediaDurationSeconds 25

# API only
.\scripts\api-load-test.ps1 -ConcurrentLevels "1,2,3,5,8" -HoldSeconds 8

# Media only (single shot — good for debug, not for stats)
.\scripts\media-load-test.ps1 -ConcurrentRooms "1,2,3,5" -DurationSeconds 40

# Media × 4 repeats → min/p50/avg/max (recommended before quoting numbers)
.\scripts\run-repeated-media-load.ps1 -Repetitions 4 -ConcurrentRooms "1,3,5" -DurationSeconds 25
```

> Use comma-separated strings for levels (not `@(...)`) so `powershell -File` does not split arrays into positional args.  
> Real browser protocol (3–4 × 5 min): [real-world-test-protocol.md](real-world-test-protocol.md).


## How to read numbers

| Metric | Meaning |
|---|---|
| **Max concurrent pairs @ 100% (API)** | App path held that many 1:1 calls (signaling + token) without error |
| **Busy rule PASS** | Third party cannot call a busy user (HTTP 409) |
| **Max media rooms @ 100%** | SFU accepted N rooms × 2 video publishers for the full duration (process exit 0) |
| **LiveKit CPU%** | Host pressure signal; on laptop Docker Desktop this is **not** VPS GOLD4 |
| **Mbps in / out / total** | From Prometheus `livekit_packet_bytes` delta over the level window (SFU-observed) |
| **pkt/s** | From `livekit_packet_total` deltas |
| **loss% avg** | From `livekit_packet_loss_percent_sum/count` (histogram mean) |
| **node drop%** | From `livekit_node_packet_total{type=dropped}` vs out |

**Important**

- CLI media publishers are **not** browser encode cost (client CPU/camera differs).
- Prometheus path is **SFU counters**, not browser `getStats` (RTT/jitter per peer still needs PERF plan / quality panel).
- With `SubscribersPerRoom=0`, **Mbps out** stays near zero (publish-only). Default suite uses subscribers so forward path is visible.
- Suite run on a **dev laptop** ≠ VPS **2 vCPU / 4 GB**. Re-run on VPS for deploy capacity claims.
- These are **measured observations**, not contractual SLAs.

## Synthetic users

- `L01`…`L40` (tenant-a), password `Demo@123`.
- Hidden from login picker and `/api/identities` (see `IdentityRegistry.Directory`).
- Count override: env `LOAD_TEST_USER_COUNT` (0–200) at backend start.

## Latest measured snapshot (local Docker host, 2026-08-06)

See [../evidence/capacity-runs/2026-08-06-measured-summary.md](../evidence/capacity-runs/2026-08-06-measured-summary.md).

| Layer | Measured (this host) |
|---|---|
| API concurrent 1:1 pairs | **20/20 @ 100%** (max synthetic users) |
| Busy rule | PASS (409) |
| Media rooms × 2 pubs | **10/10 @ 100%**, LiveKit CPU peak **~97%** at 10 rooms (pre-Prometheus run) |
| Comfort media (CPU headroom) | roughly **5–8** rooms before peaks get high |
| Prometheus media (1 / 3 rooms, pubs+subs) | ~**6 / 18 Mbps total**, loss **~0%** (local Docker) — see `evidence/capacity-runs/2026-08-06-prometheus-media.md` |

Re-run on VPS before quoting deploy capacity. Note: local UDP port range is only **50000–50020** (~21 ports); high room counts may not scale Mbps linearly.

## Related

- Sustained 5‑minute human call plan: [performance-test-plan.md](performance-test-plan.md)
- Workload inputs (no invented TCO): `../../../docs/workload-scenarios.md`
