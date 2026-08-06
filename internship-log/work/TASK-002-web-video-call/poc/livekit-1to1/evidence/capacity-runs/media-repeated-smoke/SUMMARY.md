# Repeated media load (N=2)

- Rooms ladder: `1` · duration 12s · subs/room=2
- Exit codes: 0, 0
- All runs exit 0: **yes**

## Aggregates (min / p50 / avg / max across repeats)

| Rooms | # | success avg% | Mbps total p50 | Mbps total avg | Mid total p50 | loss% avg | CPU peak p50 |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 2 | 100 | 6.42 | 6.47 | 9.642 | 0 | 10.62 |

Per-run folders: `run-01/` … `run-NN/`. Full JSON: `aggregate-report.json`.

> Single run is a **sample**. Use p50/avg over 3–4 repeats for PoC claims; do not treat min of one run as capacity.
