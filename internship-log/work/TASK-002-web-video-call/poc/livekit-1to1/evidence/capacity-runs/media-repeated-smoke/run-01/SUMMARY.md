# Media SFU load test report

- LiveKit: `http://localhost:7880`
- Prometheus: `http://localhost:6789/metrics`
- Topology: **N rooms × 2 video publishers + 2 subscribers**
- Resolution: high · Duration: 12s
- Max rooms with **100% success**: **1**
- Success = connected (CLI logs) and ran ≥80% of duration (or clean exit 0).
- **Mbps / loss** from LiveKit `/metrics` (`livekit_packet_bytes`, `livekit_packet_loss_percent_*`) over the level window.
- CLI publishers ≠ browser encode; local Docker path ≠ multi-network WAN.

| Rooms | OK | CPU peak% | Mbps in | Mbps out | Mbps total | Mid total Mbps | pkt/s in | loss% | rooms | parts |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1/1 | 10.9 | 3.618 | 2.903 | 6.521 | 9.664 | 425.1 | 0 | 1 | 0 |

Artifacts: `media-load-report.json`, `docker-stats.tsv`, `livekit-metrics.tsv`, `logs-rooms-*/`
