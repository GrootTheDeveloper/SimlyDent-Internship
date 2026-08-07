# Browser regression (Playwright) — R3 R4 R5 R6 R11 R13

**Date:** 2026-08-07  
**Base:** https://103.28.32.118.sslip.io  
**Runner:** Chromium + fake media devices (`--use-fake-device-for-media-stream`)  
**Script:** temp `run-manual-r.mjs` (2 contexts A1/A2)

## Results

| ID | Status | Detail |
|----|--------|--------|
| LOGIN | PASS | A1 and A2 portals ready |
| CALL_SETUP | PASS | both media connected (video call) |
| **R3** | **PASS** | toggle cam ×10; last title=Tắt camera |
| **R4** | **PASS** | both sides toggled without teardown |
| **R5** | **PASS** | Mở lại clicked; call window pages stable |
| **R6** | **PASS** | stayed on /call after forced media disconnect attempt |
| **R11** | **PASS** | snapshot control clicked; stayed on call |
| **R13** | **PASS** | reload reconnected media |

## Raw JSON

```json
[
  {
    "id": "LOGIN",
    "status": "PASS",
    "detail": "A1 and A2 portals ready",
    "at": "2026-08-07T15:42:06.750Z"
  },
  {
    "id": "CALL_SETUP",
    "status": "PASS",
    "detail": "both media connected",
    "at": "2026-08-07T15:42:10.981Z"
  },
  {
    "id": "R3",
    "status": "PASS",
    "detail": "toggle cam ×10 ok; last title=Tắt camera",
    "at": "2026-08-07T15:42:18.495Z"
  },
  {
    "id": "R4",
    "status": "PASS",
    "detail": "both sides toggled without teardown",
    "at": "2026-08-07T15:42:25.632Z"
  },
  {
    "id": "R5",
    "status": "PASS",
    "detail": "reopen clicked; call window pages=2 (before 2)",
    "at": "2026-08-07T15:42:27.187Z"
  },
  {
    "id": "R6",
    "status": "PASS",
    "detail": "url=https://103.28.32.118.sslip.io/call/34bb4c1c-99b0-4a91-801c-5f317539d840?user=A1&media=video; rejoin=0",
    "at": "2026-08-07T15:42:29.205Z"
  },
  {
    "id": "R11",
    "status": "PASS",
    "detail": "clicked snapshot control; UI remained on call",
    "at": "2026-08-07T15:42:31.779Z"
  },
  {
    "id": "R13",
    "status": "PASS",
    "detail": "reload reconnected media",
    "at": "2026-08-07T15:42:33.846Z"
  },
  {
    "id": "CLEANUP",
    "status": "WARN",
    "detail": "page.waitForTimeout: Target page, context or browser has been closed",
    "at": "2026-08-07T15:42:33.967Z"
  }
]
```

## Notes

- Fake media devices — not physical camera; validates LiveKit publish/toggle/UI stability.
- R6 used Vue `mediaEngine.disconnectMedia` / room disconnect without intentionalLeave; page remained on call route.
- CLEANUP warn: page closed before hangup wait (non-blocking).
- Embed (visitor iframe) not included in this dual-staff run; R7 assets previously 200.