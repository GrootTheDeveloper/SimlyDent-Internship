# Capacity suite combined report

- Host: GROOTTHEDEVELOP · Microsoft Windows NT 10.0.26200.0
- UTC: 2026-08-05T18:18:03.0929374+00:00
- Local Docker Desktop host unless run on VPS. VPS GOLD4 = 2 vCPU / 4 GB — re-run suite there for production-ish numbers.

## API / signaling
- Skipped or failed to produce report.

## Media SFU (CLI publishers)
- Skipped or failed to produce report.

## How to read
- **API pairs** = app JWT call lifecycle concurrent capacity (business path).
- **Media rooms** = LiveKit SFU forwarding load with synthetic video (not browser encode).
- Numbers on a laptop Docker host are **not** VPS GOLD4 numbers — re-run on VPS for deploy capacity.
