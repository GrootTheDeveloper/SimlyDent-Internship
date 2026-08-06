# Residual tech debt inventory — LiveKit 1:1 PoC (2026-08-06)

Bounded audit after JWT auth + presence + call UX work. Items are **fix-now** (this goal) or **deferred** (explicit non-goals / nice-to-haves).

## Fix-now

| ID | Area | Finding | Resolution |
|---|---|---|---|
| D-01 | Scripts | `scripts/smoke-test.ps1` still sent only `X-User-Id` (spoofable; fails under JWT) | Login → `Authorization: Bearer` for all authenticated calls |
| D-02 | Scripts | `scripts/recording-e2e-test.ps1` same header reliance | Same JWT helper path |
| D-03 | Docs | README “Giới hạn đã biết” still claimed `X-User-Id` principal spoof | Document JWT login (`Demo@123`) + Bearer; keep production caveats (HttpOnly refresh, Redis presence, etc.) |
| D-04 | Docs | `docs/vps-deploy.md` §8 contradicted §12 (header auth vs JWT) | Align §8 with JWT; keep “not production hardened” warning |
| D-05 | Runtime | Local Docker backend image older than JWT source (login 404, `X-User-Id` still accepted) | Rebuild `backend` (+ frontend if needed) so shipped path matches source |
| D-06 | Compose | Local `docker-compose.yml` did not surface `JWT_*` env (defaults only) | Pass through optional `JWT_SECRET` / lifetime for parity with VPS |
| D-07 | UX | Ended-call toast stayed until manual close | Auto-clear after 2.5s when not active |

## Already fixed in source (no further code change this pass)

| ID | Area | Notes |
|---|---|---|
| U-01 | Call hangup race | `endCall` races recording/telemetry with 1.5s cap; always `handleCallEnded` |
| U-02 | Select user stuck after call | `isCallActive` only Ringing/Accepted; `CALL_WINDOW_CLOSED` clears UI; `closePopup` releases lock |
| U-03 | Online/offline | JWT hub + `PresenceRegistry` connection count; call disabled when offline |
| U-04 | Multi-tenant UI | Directory scoped to same tenant; cross-tenant call blocked client + API 403 |
| U-05 | Video orientation / letterbox / PiP FOV | Contain-letterbox path; no double-rotate cover crop |

## Deferred (out of this goal)

| ID | Item | Why deferred |
|---|---|---|
| F-01 | Redis multi-node presence | Non-goal; single-instance PoC |
| F-02 | HttpOnly refresh cookies | Non-goal SPA shape for now |
| F-03 | Custom domain / replace sslip.io | Ops decision |
| F-04 | Vue 3 migration | Explicit non-goal |
| F-05 | Production consent UI, S3/MinIO, encryption productization | Covered by **recording/storage plan**, not implement now |
| F-06 | Missed-call / no-answer timer product polish | Product backlog |
| F-07 | Full multi-device 5‑minute live campaign as CI gate | Plan is deliverable; smoke re-run is gate |
| F-08 | (moved) Auto-dismiss ended toast | Fixed as D-07 |

## Auth source of truth (post-fix)

1. `POST /api/auth/login` `{ userId, password }` → access JWT  
2. REST: `Authorization: Bearer <token>`  
3. SignalR: `accessTokenFactory` / query `access_token`  
4. Identity from JWT claims only — **not** `X-User-Id`
