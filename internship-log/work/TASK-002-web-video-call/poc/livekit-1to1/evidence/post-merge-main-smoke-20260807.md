# Post-merge `main` smoke — 2026-08-07

**HEAD (local + VPS):** `0e49b82` — merge: production refactor call/media (Phase 0–8)  
**URL:** https://103.28.32.118.sslip.io  
**Branch:** `main`

## VPS

| Check | Result |
|-------|--------|
| Containers | All 8 up (backend/frontend recently recreated; gateway/livekit/egress/redis/postgres/minio healthy) |
| `GET /health` | `status=ok`, `featureMediaAssets=true`, catalogs=postgres |
| Widget `frame.js` | 200 |
| Widget `media-primitives.js` | 200 |

## API smoke (`scripts/smoke-test.ps1`)

**Result: 40/40 PASS**

Includes JWT auth, clinic isolation, accept/token/quality/end, busy conflict, agent ready, queue path (VA → assign → accept → token → end).

### Harness fix

`POST /api/queue/calls` (and other POST endpoints that declare optional JSON body) returned **415** when the smoke client sent no `Content-Type`.  
Fix: `Invoke-PocRequest` now sends `Content-Type: application/json` + `{}` for body-less POSTs.

## Browser regression (Playwright Chromium + fake media)

**Script:** `scripts/run-browser-regression.mjs`  
**Result:** LOGIN, CALL_SETUP, **R3 R4 R5 R6 R11 R13 = PASS** (CLEANUP WARN only — page closed after end)

Raw: `evidence/browser-regression-post-merge-2026-08-07T1551.json`

## Manual real-device (optional, not run here)

Still recommended once on two real browsers/devices: video + audio, mic both ways, **Mở lại**, hangup.
