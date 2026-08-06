# Capacity suite combined report

- Host: GROOTTHEDEVELOP · Microsoft Windows NT 10.0.26200.0
- UTC: 2026-08-05T18:30:11.8449234+00:00
- Local Docker Desktop host unless run on VPS. VPS GOLD4 = 2 vCPU / 4 GB — re-run suite there for production-ish numbers.

## API / signaling
- Busy rule: **PASS**
- Max concurrent pairs @ 100% success: **8**
- Exit code: 0
- Details: [api/SUMMARY.md](api/SUMMARY.md)

## Media SFU (CLI publishers)
- Max concurrent rooms (2 pubs each) @ 100% process success: **5**
- Duration/level: 30s · res high
- Exit code: 0
- Details: [media/SUMMARY.md](media/SUMMARY.md)

## How to read
- **API pairs** = app JWT call lifecycle concurrent capacity (business path).
- **Media rooms** = LiveKit SFU forwarding load with synthetic video (not browser encode).
- Numbers on a laptop Docker host are **not** VPS GOLD4 numbers — re-run on VPS for deploy capacity.
