# VPS ceiling ramp

- When: 2026-08-06T02:39:14Z
- Commit: 563f23e Fix VPS deploy smoke to use JWT login before /api/identities.
- RAM: 
- CPUs: 2
- Media: N rooms × 2 video pubs + 2 subs, 30s each level
- Stop when: process fail rate >0 OR LiveKit CPU mid ≥ 90% sustained OR N max

| Rooms | OK | Fail | LiveKit CPU mid% | LiveKit mem mid | Mbps total (approx) | Stop reason |
|---:|---:|---:|---:|---|---:|---|
| 1 | 1 | 0 | 15.46 | 74.95MiB / 3.852GiB | 17.597 |  |
| 3 | 3 | 0 | 23.59 | 106.4MiB / 3.852GiB | 30.820 |  |
| 5 | 5 | 0 | 33.18 | 141MiB / 3.852GiB | 49.145 |  |
| 8 | 8 | 0 | 53.43 | 188.3MiB / 3.852GiB | 52.778 |  |
| 10 | 10 | 0 | 50.27 | 171MiB / 3.852GiB | 61.319 |  |
| 12 | 12 | 0 | 60.24 | 179MiB / 3.852GiB | 59.826 |  |
| 15 | 15 | 0 | 47.25 | 186.9MiB / 3.852GiB | 60.459 |  |
| 18 | 18 | 0 | 53.13 | 176.8MiB / 3.852GiB | 51.825 |  |
| 20 | 20 | 0 | 55.17 | 216.5MiB / 3.852GiB | 60.449 |  |
| 25 | 25 | 0 | 72.83 | 240.2MiB / 3.852GiB | 59.275 |  |
| 30 | 30 | 0 | 60.90 | 242.7MiB / 3.852GiB | 64.413 |  |

**Soft end:** no process failures through N=30 and LiveKit CPU mid stayed under ~180%.

## Ceiling conclusion

- **Ceiling rooms (observed):** **30**
- **Why:** ladder max without process fail / CPU still under 180% (check table)
- Host free -h after: Mem:           3.9G        718M        1.2G         69M        2.0G        2.8G

Artifacts: `/opt/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/evidence/capacity-runs/vps-ceiling-20260806-093912`
