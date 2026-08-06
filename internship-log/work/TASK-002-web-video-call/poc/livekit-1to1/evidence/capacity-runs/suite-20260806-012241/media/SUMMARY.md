# Media SFU load test report

- LiveKit: `http://localhost:7880`
- Topology: **N rooms × 2 video publishers** (simulated 1:1)
- Resolution: high · Duration: 30s
- Max rooms with **100% success**: **5**
- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0).
- Note: CLI publishers ≠ browser CPU; SFU host load is the primary signal.

| Rooms | OK | Rate % | LiveKit CPU% after | Peak CPU% (tsv) | LiveKit Mem | Backend CPU% |
|---:|---:|---:|---:|---:|---|---:|
| 1 | 1/1 | 100 | 0.05 | 3.51 | 48.93MiB / 6.698GiB | 0.05 |
| 2 | 2/2 | 100 | 0.14 | 8.83 | 48.88MiB / 6.698GiB | 0.14 |
| 3 | 3/3 | 100 | 0.07 | 13.04 | 49.02MiB / 6.698GiB | 0.07 |
| 5 | 5/5 | 100 | 0.12 | 25.35 | 49.19MiB / 6.698GiB | 0.12 |

Artifacts: `media-load-report.json`, `docker-stats.tsv`, `logs-rooms-*/`
