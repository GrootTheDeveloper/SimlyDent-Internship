# Phase 2 plan — Public Embed API + Visitor Widget

**Status:** **PR-0 + PR-0b + PR-A + PR-B implemented**; PR-C+ pending.  
**Depends on:** Phase 0 ✅ · Phase 1 ✅ · PR-0/0b ✅ · PR-A embed session ✅ · PR-B embed calls ✅  
**Baseline PoC:** `poc/livekit-1to1/`  
**Full order:** PR-0 → PR-0b → PR-A → **PR-B** → PR-C → PR-D → PR-E  

### Five MVP invariants

1. Clinic A never leaks to Clinic B.  
2. Visitor X never accesses Visitor Y’s call (same clinic).  
3. One call ≤ one assigned staff.  
4. One staff ≤ one Ringing/InCall.  
5. Visitor disappear eventually frees queue/staff capacity.

### PR-0 / PR-0b (done)

| Item | Behavior |
|------|----------|
| Staff-only overview | `GET /api/identities|presence|agents|queue`, `POST /api/agents/ready|heartbeat` → **403** for non-staff |
| SignalR | Staff join `clinic:{id}`; visitors only personal group |
| Atomic accept/reject/cancel/end | Clinic + call locks; timeout no-ops if already Accepted |
| End/cancel | Idempotent second call → 200 with terminal status |

### PR-A (done)

| Item | Behavior |
|------|----------|
| `POST /embed/session` | site_key + **exact** Origin → Embed JWT (`aud=simlydent-embed`, `token_use=embed`, TTL **120m**) |
| ClinicSite | `pk_clinic_a` / `pk_clinic_b`; origins from env or local multi-port defaults |
| Rate limit | Per IP + site_key on session create |
| Caddy | `/embed/*` → backend (`Caddyfile`, `Caddyfile.vps`) |
| VPS secrets | `JWT_SECRET` + `EMBED_JWT_SECRET` required; `REQUIRE_STRICT_SECRETS=1` |
| Tests | `scripts/embed-session-test.ps1` |

---

## 1. Goal (one sentence)

Visitor on a clinic website presses **Call** → SimlyDent resolves **clinic from public `site_key`** → enqueues via existing dispatcher → **only assigned staff** Accept → short-lived LiveKit token → 1:1 media; **Clinic B never sees Clinic A**.

---

## 2. What Phase 2 is (and is not)

| Is | Is not |
|----|--------|
| Public Embed API (`site_key`) | Staff redesign / full CRM |
| Visitor widget (floating button) | Full custom CSS engine |
| Domain allowlist + rate limit | S3 / MinIO / RecordingPolicy scale |
| Reuse Phase 1 queue + longest | Hunt-group claim, transfer, group call |
| Staff console **minimal** (queue + Accept) | Native mobile apps |

**Split (invariant I2):**

```text
Website clinic  →  Widget (UI client only)
                        ↓
               Public Embed API  →  Backend authority
                        ↓
               LiveKit token ONLY after Accepted
```

Website/clinic **never** holds LiveKit secret, never chooses room, never picks staff.

---

## 3. Architecture (target)

```text
https://phongkham-a.vn
        │  loads widget script/iframe
        ▼
[Visitor Widget]
  states: Idle → Waiting(Queued) → Ringing → Connected → Ended
        │
        │  siteKey = pk_clinic_a  (public)
        ▼
POST /embed/session     → visitor session (httpOnly cookie or opaque token)
POST /embed/calls       → CallSession Origin=Queue, clinic from site_key map
GET  /embed/calls/{id}  → status poll (or SSE/SignalR scoped to session)
POST /embed/calls/{id}/cancel
POST /embed/calls/{id}/token  → only if Accepted + session owns call
        │
        ▼
Existing CallDispatcher + AgentRegistry (Phase 1)
        │
        ▼
Staff JWT portal (existing SPA or thin staff view)
  Accept / Reject / End  (already clinic + assigned checks)
```

**Clinic resolution**

```text
site_key  →  server table  →  ClinicId + domain allowlist + enabled flag
```

Never trust browser-supplied `clinicId`.

---

## 4. Work breakdown (PR-sized)

### PR-A — Clinic site registry + embed session (backend)

| Item | Detail |
|------|--------|
| Model | `ClinicSite { SiteKey, ClinicId, AllowedOrigins[], Enabled }` |
| Demo data | `pk_clinic_a` → clinic-a; `pk_clinic_b` → clinic-b |
| `POST /embed/session` | Validate Origin/Referer vs allowlist; mint short-lived visitor session JWT (`role=Visitor`, `clinic_id`, `session_id`) |
| Rate limit | Per IP + per site_key (in-memory for PoC) |
| Auth | Embed routes use visitor session, not staff password |

**AC:** Wrong origin → 403; unknown site_key → 404; session JWT cannot call staff APIs as staff.

### PR-B — Embed call API wired to dispatcher ✅

| Item | Detail |
|------|--------|
| `POST /embed/calls` | Enqueue for session clinic (reuse `CallDispatcher.EnqueueAsync`); 1 active call / session |
| `GET /embed/calls/{id}` | Session ownership only; updates `VisitorLastSeenAt` (poll = heartbeat) |
| `POST .../cancel` | Queued/Ringing only; idempotent |
| `POST .../end` | Accepted only; frees staff + redispatch |
| `POST .../token` | After Accepted only; exact server room in LiveKit JWT |
| DTO | `EmbedCallView` — id/status/timestamps/waiting; **no** roomName/recording/staff |
| Auth | Policy `EmbedVisitor` (`EmbedBearer` + `token_use=embed`); staff JWT → 401 |
| Stale | `EMBED_VISITOR_STALE_SECONDS` (default 90): abandon active embed call if no poll |
| Tests | `scripts/embed-isolation-test.ps1` |

**AC:** VB/`pk_clinic_b` cannot read clinic-a call id; same-clinic other session 404; isolation suite extended.

### PR-C — Visitor widget (minimal UI)

| Item | Detail |
|------|--------|
| Deliverable | `widget/` or `frontend-embed/` static bundle |
| UI | Floating button; Waiting / Ringing / Connected / Ended |
| Media | getUserMedia **only** on Accepted; LiveKit join with embed token |
| Config | `data-site-key`, optional colors/name |
| Snippet | One script tag docs for clinic site |

**AC:** Demo page for clinic-a and clinic-b on VPS; real call with staff A1.

### PR-D — Staff surface polish (minimal)

| Item | Detail |
|------|--------|
| Queue panel | Show `GET /api/queue` + `QueueUpdated` |
| Agent badge | Available / Ringing / InCall |
| Accept only assigned | Already enforced; clarify UI copy |
| No full console rewrite | Extend current SPA |

### PR-E — Tests + docs + deploy

| Item | Detail |
|------|--------|
| `scripts/embed-isolation-test.ps1` | site_key A vs B, origin check, token rules |
| Extend smoke | One embed happy path if local secret-less harness allows |
| Docs | Snippet, env vars, Phase 2 DoD |
| VPS | Deploy widget static + backend |

---

## 5. API sketch (stable names)

```http
POST /embed/session
  Body: { "siteKey": "pk_clinic_a" }
  Headers: Origin: https://phongkham-a.vn
  → { "accessToken", "expiresAt", "clinicId", "sessionId" }

POST /embed/calls
  Authorization: Bearer <visitor-session>
  → { "id", "status": "Queued"|"Ringing", "roomName"? }  // roomName optional until accepted

GET /embed/calls/{id}
  → CallView subset (no other clinic fields)

POST /embed/calls/{id}/cancel

POST /embed/calls/{id}/token
  → { "url", "token", "expiresAt" }  // only Accepted
```

Staff continues on existing `/api/*` JWT routes.

---

## 6. Security checklist (Phase 2)

- [ ] `clinicId` only from site_key map / visitor session claims  
- [ ] Origin allowlist enforced on session create  
- [ ] Rate limit embed endpoints  
- [ ] Visitor session cannot list staff directory of other clinics  
- [ ] No LiveKit API secret in widget  
- [ ] Media token only after Accept + ownership  
- [ ] Cross-site_key isolation automated  
- [ ] Recording still staff/clinic authorized (no visitor download)

---

## 7. Config / env (proposed)

```env
# Demo sites (or JSON file)
EMBED_SITE_PK_CLINIC_A=pk_clinic_a
EMBED_SITE_PK_CLINIC_B=pk_clinic_b
EMBED_ALLOWED_ORIGINS_CLINIC_A=https://demo-a.example,http://localhost:5174
EMBED_SESSION_MINUTES=30
EMBED_RATE_LIMIT_PER_IP_PER_MIN=30
```

PoC may hardcode demo map in `ClinicSiteRegistry` first (like `IdentityRegistry`).

---

## 8. Test plan Phase 2

| Suite | Cases |
|-------|--------|
| Unit/integration | site_key → clinic; bad origin; rate limit |
| `embed-isolation-test.ps1` | A site cannot touch B call; token rules |
| E2E manual | Widget demo-a + staff A1/A2 on VPS |
| Regression | `run-test-suite.ps1` (smoke + isolation + routing) must stay green |

---

## 9. Order of execution

```text
1. PR-A  ClinicSite + /embed/session
2. PR-B  /embed/calls* → CallDispatcher
3. PR-E partial  isolation tests for embed
4. PR-C  Widget MVP + demo pages
5. PR-D  Staff queue panel polish
6. PR-E  Docs + VPS deploy + full suite
```

**Estimate (PoC):** ~3–6 focused days depending on widget polish.

---

## 10. Explicit debt left for later phases

- Working hours calendar UI (Closed without enqueue)  
- RecordingPolicy None/Audio/Video + consent  
- Object storage path `clinic/{id}/…`  
- 50-call recording capacity  
- Production CDN widget versioning  

---

## 11. Definition of Done (Phase 2)

- [ ] Demo clinic-a website/widget creates queue call without staff password  
- [ ] Staff clinic-a receives assign + Accept; media works  
- [ ] clinic-b site_key/staff cannot access clinic-a embed call  
- [ ] Widget never receives LiveKit secret  
- [ ] `run-test-suite.ps1` + embed isolation PASS on VPS  
- [ ] README snippet for clinic integration  

---

## 12. Immediate next action after this plan

1. Keep Phase 1 tests green (`run-test-suite.ps1`).  
2. Start **PR-A** (`ClinicSiteRegistry` + `POST /embed/session`) on a branch.  
3. Do not build widget before session + enqueue API exist.
