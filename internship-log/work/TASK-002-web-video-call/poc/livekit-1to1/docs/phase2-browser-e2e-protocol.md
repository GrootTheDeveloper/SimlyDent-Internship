# Phase 2 — Browser E2E protocol (PR-E)

**Purpose:** Manual checklist to close Phase 2 DoD.  
**Harness model:** fake **clinic websites** on different origins; widget + API load from **SimlyDent (VPS)**.

## Origin rules (locked)

- **Origin** = `scheme` + `hostname` + `port` only.
- Different **paths** on the same host (e.g. `/widget/demo-a` vs `/widget/demo-b`) are **not** multi-origin.
- Valid multi-origin differences: **subdomain, hostname, port, or scheme**.

## Prerequisites

1. VPS (or local stack) healthy: `GET {ApiBase}/health` → 200.
2. Remote widget: `GET {ApiBase}/widget/embed.js` → 200.
3. Allowlist includes harness origins (defaults):  
   `http://127.0.0.1:5174`, `http://localhost:5174`,  
   `http://127.0.0.1:5175`, `http://localhost:5175`.
4. Staff demo: `A1` / `Demo@123` (clinic-a); optional `B1` for isolation.

## Start harness

```powershell
cd poc/livekit-1to1   # from repo path
.\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://YOUR_VPS" -ProbeAndServe
```

| URL | Role |
|-----|------|
| `http://127.0.0.1:5174/` | Fake **Clinic A** site |
| `http://127.0.0.1:5175/` | Fake **Clinic B** site |
| `https://YOUR_VPS/` | Staff portal + widget host + Embed API |

Architecture:

```text
localhost:5174 = website Clinic A
  └─ remote https://VPS/widget/embed.js
     data-site-key=pk_clinic_a
     data-api-base=https://VPS

localhost:5175 = website Clinic B
  └─ remote https://VPS/widget/embed.js
     data-site-key=pk_clinic_b
```

## E1 — Origin binding 4-way (API, required)

```powershell
.\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://YOUR_VPS" -ProbeOnly
```

| # | Case | Expected |
|---|------|----------|
| 1 | Origin A + `pk_clinic_a` | **200** |
| 2 | Origin B + `pk_clinic_b` | **200** |
| 3 | Origin B + `pk_clinic_a` | **403** |
| 4 | Origin A + `pk_clinic_b` | **403** |

Also covered by `embed-session-test.ps1` inside `run-test-suite.ps1`.

## E2-1 — Happy path Clinic A (required)

| Step | Who | Action | Expect |
|------|-----|--------|--------|
| 1 | Staff | Open **VPS** portal, login **A1**, become Available | Agent badge Available |
| 2 | Visitor | Open harness **:5174**, click call | Waiting/Queued; **no** camera prompt on landing |
| 3 | Staff | See queue + popup **gán cho bạn** | Only assigned staff can Accept |
| 4 | Staff | Accept | Call InCall / ringing cleared |
| 5 | Visitor | Join; camera optional (mic-only OK) | Connected; guest avatar OK if no video |
| 6 | Either | End | Staff Available; queue clear |
| 7 | Security | DevTools → Network | See security rules below |

## E2-2 — Cross clinic isolation (required)

| Step | Expect |
|------|--------|
| Create call from Origin A (or keep id from E2-1 before end) | callId A exists |
| Session with Origin B / key B: `GET /embed/calls/{idA}` | **404** |
| Staff **B1** JWT: GET or accept call A | **404** |
| 4-way origin AC already PASS | |

Automated coverage: `embed-isolation-test.ps1`.

## E2-3 — Optional polish

| Case | Expect |
|------|--------|
| Cancel while Queued | Terminal cancelled; staff not stuck Ringing |
| Deny camera → audio / receive-only + retry devices | No new call rejoin |
| Reload parent with sessionStorage | Resume same session if still valid |

## Security spot-check (locked wording)

```text
PASS if:
  - No LiveKit API key / API secret / signing secret exposed in widget JS or network.
  - Short-lived participant join token after Accepted is expected (normal).

FAIL if:
  - LiveKit server API key/secret, EMBED_JWT_SECRET, or app JWT signing secret
    appears in client bundles or responses to the browser.
```

## Automated close-out (required for final evidence)

```powershell
# FULL suite — do NOT use -SkipSlow for Phase 2 final evidence
.\scripts\run-test-suite.ps1 -ApiUrl "https://YOUR_VPS"
```

| When | `-SkipSlow` |
|------|-------------|
| Local debug / E0 baseline | Allowed |
| **Final evidence closing Phase 2** | **Forbidden** |

## Evidence

Write results to:

`evidence/YYYY-MM-DD-phase2-embed-vps.md`

Include: commit SHA, ApiBase, full suite log summary, 4-way table, E2-1/E2-2 PASS, security ticks.
