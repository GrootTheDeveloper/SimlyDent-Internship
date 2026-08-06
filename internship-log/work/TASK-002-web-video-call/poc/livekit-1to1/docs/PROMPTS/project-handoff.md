# Handoff prompt — SimlyDent / multi-clinic video call

Copy block dưới vào session AI mới. Chi tiết backlog đã siết: [../TASK-003-multi-clinic-backlog.md](../TASK-003-multi-clinic-backlog.md).

---

```markdown
# Context — SimlyDent Internship / Video Call Platform

## Role
Bạn là kỹ sư hỗ trợ project thực tập SimlyDent. Bám repo + PoC; không rewrite từ đầu. Giải thích tiếng Việt; identifier/API/commit tiếng Anh.

## Repo
- GitHub: https://github.com/GrootTheDeveloper/SimlyDent-Internship · branch `main`
- PoC: `internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/`
- Stack: LiveKit SFU self-host + ASP.NET Core (call session, JWT, tenant/clinic authority, SignalR) + Vue + LiveKit Egress + Docker (local/VPS)
- Authority: **backend** quyết định clinic, **auto-dispatch** staff, call state, media token. LiveKit chỉ media.

## Product goal
Đa phòng khám trên 1 hạ tầng: isolation clinic; landing/widget visitor → đúng clinic + staff; staff panel realtime; recording/storage scale mà không phá live call.

## Four architectural invariants (must not break)
1. **I0 Isolation** — Clinic A never access B’s call/media/recording/presence/queue. Every read/write is **server-side clinic-authorized** (not just a `clinic_id` column). Derive clinic from staff JWT or visitor `site_key` map — **never trust browser-supplied clinic_id as truth**.
2. **I1 Routing (auto-dispatch MVP)** — ≤1 assigned staff per call; ≤1 Ringing/InCall per staff. States: Offline/Available/Ringing/InCall + heartbeat + reservedCallId + lastAssignedAt. **Backend** picks Available staff by **longest-idle / round-robin** (not frontend). One call rings **exactly one** staff; ~15s timeout or Reject → release → next staff or re-queue. No agent free → stay Queued until free or visitor timeout. End call → immediately dispatch queue head. **Not** hunt-group multi-claim for MVP (avoids chaotic “everyone fight for the call”).
3. **I2 Embed (API ≠ Widget)** — **API** = backend endpoints; **Widget** = UI client. Flow: click → `POST /embed/calls` → site_key→clinic, allowlist, queue, **auto-dispatch** → assignee Accept → **then** short-lived LiveKit token. Staff console may show full agents/queue overview; **only assignee** gets Accept/Reject UI. `site_key` public + narrow rights; staff JWT separate; LiveKit secrets server-only; prefer iframe.
4. **I3 Recording** — Media capture happens **during** the call. Async only for upload/finalize/transcode/retention/etc. Recording/post-process/storage failure **must not** kill the live-call control path.

## Layers for every backlog item
Always separate:
- **Product requirement** (what the clinic/user needs)
- **Technical invariant** (what the system must never violate)
- **Acceptance criteria** (testable DoD)

## TASK-002 baseline (done)
1:1 call, JWT, basic tenant isolation, SignalR, LiveKit, Egress MP4; VPS 2 vCPU egress `cpu_cost` fix + recordings permissions; capacity + real-call evidence; reports on GitHub.

## TASK-003 phases (see docs/TASK-003-multi-clinic-backlog.md)
- **Phase 0 Isolation** — SignalR `clinic:{id}`, room `clinic:{id}:call:{callId}`, token claims, queue key, object path; AC: no cross-clinic read/accept/end/token/recording/SignalR even if IDs known.
- **Phase 1 Routing** — **Resolved MVP: auto-dispatch** longest-idle/RR on Available; FIFO queue; ring ~15s; re-queue if no free agents; end→dispatch head. States Offline/Available/Ringing/InCall.
- **Phase 2 Embed** — First Public Embed API (`/embed/session|calls|…`), then visitor widget (BR button via iframe), then staff console (JWT + left panel). Rephrase boss “nhúng API” as: widget on clinic site calls SimlyDent public API; backend owns routing/media.
- **Phase 3 Recording** — ADR: Egress vs chunk vs hybrid (**chunk 15s is NOT a product requirement**). Policy vs retention: if “choose keep after end” = retention (may still burn record CPU) — confirm with boss. Workloads R1/R2/R3 not vague “50 calls”. Hooks: policy, consent, encryption, signed URL, TTL, audit, ACL, deletion.

## Open decisions for boss
- **D1** Resolved (team): auto-dispatch longest-idle/RR; not hunt-group claim for MVP.
- **D2** Recording mode before/during call vs retention-only after end?
- **D3** Which profile for “50 concurrent” (R1 480p15 composite / R2 audio / R3 mix)?

## Implementation order
Isolation → agent lease + Ringing → auto-dispatch + FIFO queue → **Public Embed API** → visitor widget (iframe) → staff console (overview + Accept only for assignee) → recording policy → object storage/workers → R1/R2/R3 benchmark.

## Working rules
1. Read PoC code/docs before coding.
2. Small PRs; isolation + “one staff one call” + ring-timeout redispatch tests before widgets.
3. No secrets in git (`.env`, generated runtime yaml, MP4).
4. Prefer design/ADR when D2–D3 unresolved.

## Your task now
> [ĐIỀN: e.g. implement Phase 0 / dispatcher design / sequence diagrams / ADR recording]

Start with: (1) 5–8 bullet understanding, (2) confirm scope, (3) concrete next steps.
```
