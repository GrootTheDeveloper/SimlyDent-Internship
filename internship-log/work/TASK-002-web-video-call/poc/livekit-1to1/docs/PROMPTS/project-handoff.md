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
- Authority: **backend** quyết định clinic, invite/claim, call state, media token. LiveKit chỉ media.

## Product goal
Đa phòng khám trên 1 hạ tầng: isolation clinic; landing/widget visitor → đúng clinic + staff; staff panel realtime; recording/storage scale mà không phá live call.

## Four architectural invariants (must not break)
1. **I0 Isolation** — Clinic A never access B’s call/media/recording/presence/queue. Every read/write is **server-side clinic-authorized** (not just a `clinic_id` column). Derive clinic from staff JWT or visitor `site_key` map — **never trust browser-supplied clinic_id as truth**.
2. **I1 Routing** — At any instant: ≤1 assigned agent per call; ≤1 active call per agent (MVP capacity=1). Agent state is a **lease** (Available/Ringing/InCall/Offline + heartbeat + reservedCallId), not a boolean.
3. **I2 Embed (API ≠ Widget)** — **API** = backend endpoints; **Widget** = UI client of that API (floating button). Clinic website only drops a script/iframe + public `site_key`. Flow: click → `POST /embed/calls` → backend maps site_key→clinic, domain allowlist, queue, staff claim → **only then** short-lived LiveKit token. Widget never picks room / never holds LiveKit secret. `site_key` is **public** (narrow rights: create session/call, read own status, cancel own) — not clinic-wide secret. Staff uses real JWT + Staff API (`/staff/queue`, accept/reject), not site_key. Prefer iframe (or script that creates iframe) for PoC isolation.
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
- **Phase 1 Routing** — States Offline/Available/Ringing/InCall; stale → Offline + release + redispatch. **Lock one primary mode for MVP** (proposed: **hunt-group atomic claim**; auto-dispatch later). Queue MVP: FIFO, capacity 1, configurable ring/visitor timeouts, reject→next, end→Available.
- **Phase 2 Embed** — First Public Embed API (`/embed/session|calls|…`), then visitor widget (BR button via iframe), then staff console (JWT + left panel). Rephrase boss “nhúng API” as: widget on clinic site calls SimlyDent public API; backend owns routing/media.
- **Phase 3 Recording** — ADR: Egress vs chunk vs hybrid (**chunk 15s is NOT a product requirement**). Policy vs retention: if “choose keep after end” = retention (may still burn record CPU) — confirm with boss. Workloads R1/R2/R3 not vague “50 calls”. Hooks: policy, consent, encryption, signed URL, TTL, audit, ACL, deletion.

## Open decisions for boss (block deep design)
- **D1** Auto-dispatch vs staff claim?
- **D2** Recording mode before/during call vs retention-only after end?
- **D3** Which profile for “50 concurrent” (R1 480p15 composite / R2 audio / R3 mix)?

## Implementation order
Isolation → agent lease + atomic claim → visitor queue → **Public Embed API** → visitor widget (iframe) → staff console → recording policy → object storage/workers → R1/R2/R3 benchmark.

## Working rules
1. Read PoC code/docs before coding.
2. Small PRs; isolation + claim-race tests before widgets.
3. No secrets in git (`.env`, generated runtime yaml, MP4).
4. Prefer design/ADR when D1–D3 unresolved.

## Your task now
> [ĐIỀN: e.g. update Resolved D1–D3 / sequence diagrams / implement Phase 0 / ADR recording]

Start with: (1) 5–8 bullet understanding, (2) confirm scope, (3) concrete next steps.
```
