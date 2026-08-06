# Media SFU load test report

- LiveKit: `http://localhost:7880`
- Topology: **N rooms × 2 video publishers** (simulated 1:1)
- Resolution: high · Duration: 25s
- Max rooms with **100% success**: **10**
- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0).
- Note: CLI publishers ≠ browser CPU; SFU host load is the primary signal.

| Rooms | OK | Rate % | LiveKit CPU% after | Peak CPU% (tsv) | LiveKit Mem | Backend CPU% |
|---:|---:|---:|---:|---:|---|---:|
| 8 | 8/8 | 100 | 0.06 | 78.7 | 60.91MiB / 6.698GiB | 0.06 |
| 10 | 10/10 | 100 | 0.06 | 96.69 | 60.9MiB / 6.698GiB | 0.06 |

Artifacts: `media-load-report.json`, `docker-stats.tsv`, `logs-rooms-*/`
