# Browser regression post-merge

**Base:** https://103.28.32.118.sslip.io
**At:** 2026-08-07T15:51:51.936Z

| ID | Status | Detail |
|----|--------|--------|
| LOGIN | **PASS** | A1 and A2 portals ready |
| CALL_SETUP | **PASS** | both media connected |
| R3 | **PASS** | toggle cam ×10 ok; last title=Tắt camera |
| R4 | **PASS** | both sides toggled without teardown |
| R5 | **PASS** | reopen clicked; call window pages=1 (before 1) |
| R6 | **PASS** | url=https://103.28.32.118.sslip.io/call/eefc3fe2-af32-4186-8b1c-9a7c67223f3e?user=A1&media=video; rejoin=0 |
| R11 | **PASS** | clicked snapshot control; UI remained on call |
| R13 | **PASS** | reload reconnected media |
| CLEANUP | **WARN** | page.waitForTimeout: Target page, context or browser has been closed |
