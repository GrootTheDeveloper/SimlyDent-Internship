# Media SFU load test report

- LiveKit: `http://localhost:7880`
- Topology: **N rooms × 2 video publishers** (simulated 1:1)
- Resolution: high · Duration: 30s
- Max rooms with **100% success**: **5**
- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0).
- Note: CLI publishers ≠ browser CPU; SFU host load is the primary signal.

| Rooms | OK | Rate % | LiveKit CPU% after | Peak CPU% (tsv) | LiveKit Mem | Backend CPU% |
|---:|---:|---:|---:|---:|---|---:|
| 1 | 1/1 | 100 | 0.1 | 6.26 | 55.28MiB / 6.698GiB | 0.1 |
| 2 | 2/2 | 100 | 0.11 | 7.28 | 55.34MiB / 6.698GiB | 0.11 |
| 3 | 3/3 | 100 | 0.07 | 27.21 | 56.71MiB / 6.698GiB | 0.07 |
| 5 | 5/5 | 100 | 0.06 | 39.41 | 56.64MiB / 6.698GiB | 0.06 |

Artifacts: `media-load-report.json`, `docker-stats.tsv`, `logs-rooms-*/`
