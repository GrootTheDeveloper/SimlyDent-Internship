# Media SFU load test report

- LiveKit: `http://localhost:7880`
- Prometheus: `http://localhost:6789/metrics`
- Topology: **N rooms × 2 video publishers + 2 subscribers**
- Resolution: high · Duration: 25s
- Max rooms with **100% success**: **5**
- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0).
- **Mbps / loss** from LiveKit `/metrics` (`livekit_packet_bytes`, `livekit_packet_loss_percent_*`) over the level window.
- CLI publishers ≠ browser encode; local Docker path ≠ multi-network WAN.

| Rooms | OK | CPU peak% | Mbps in | Mbps out | Mbps total | Mid total Mbps | pkt/s in | loss% | rooms | parts |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1/1 | 9.13 | 3.025 | 3.042 | 6.067 | 7.98 | 357.6 | 0 | 1 | 0 |
| 3 | 3/3 | 27.47 | 8.82 | 8.877 | 17.697 | 22.77 | 1042.3 | 0 | 3 | 0 |
| 5 | 5/5 | 11.07 | 3.213 | 3.779 | 6.992 | 7.796 | 390 | 0 | 1 | 0 |

Artifacts: `media-load-report.json`, `docker-stats.tsv`, `livekit-metrics.tsv`, `logs-rooms-*/`
