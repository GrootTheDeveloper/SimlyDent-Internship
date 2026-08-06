# Media SFU load test report

- LiveKit: `http://localhost:7880`
- Prometheus: `http://localhost:6789/metrics`
- Topology: **N rooms × 2 video publishers + 2 subscribers**
- Resolution: high · Duration: 25s
- Max rooms with **100% success**: **5**
- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0).
- **Mbps / loss** from LiveKit `/metrics` (`livekit_packet_bytes`, `livekit_packet_loss_percent_*`) over the level window.
- CLI publishers ≠ browser encode; local Docker path ≠ multi-network WAN.

| Rooms | OK | CPU peak% | Mbps in | Mbps out | Mbps total | pkt/s in | loss% avg | rooms | parts |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1/1 | 8.65 | 3.124 | 3.434 | 6.558 | 365 | 0 | 1 | 0 |
| 3 | 3/3 | 24.38 | 10.171 | 9.764 | 19.935 | 1193.4 | 0 | 3 | 0 |
| 5 | 5/5 | 24.38 | 2.55 | 3.149 | 5.699 | 314.6 | 0 | 5 | 0 |

Artifacts: `media-load-report.json`, `docker-stats.tsv`, `livekit-metrics.tsv`, `logs-rooms-*/`
