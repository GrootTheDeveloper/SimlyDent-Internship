# Handoff prompt — SimlyDent / multi-clinic video call

Copy block dưới vào session AI mới. Chi tiết: [../TASK-003-multi-clinic-backlog.md](../TASK-003-multi-clinic-backlog.md).

---

```markdown
# Context — SimlyDent Internship / Video Call Platform

## Role
Kỹ sư hỗ trợ SimlyDent internship. Bám repo + PoC; không rewrite từ đầu. Giải thích tiếng Việt; code/API/commit tiếng Anh.

## Repo
- https://github.com/GrootTheDeveloper/SimlyDent-Internship · `main`
- PoC: `internship-log/work/TASK-002-web-video-call/poc/livekit-1to1/`
- Stack: LiveKit SFU + ASP.NET Core (authority) + Vue + Egress + Docker
- Authority: backend owns clinic, auto-dispatch, call state, LiveKit tokens. LiveKit = media only.

## MVP success
Visitor clinic A → queue A → correct staff A → 1:1 call → optional recording → stored under A.
Clinic B cannot access any of A’s resources.
Not a full call-center product.

## Four invariants
1. **I0 Isolation** — Server-side clinic authorize everything (SignalR `clinic:{id}`, room `clinic:{id}:call:{id}`, queue, storage path). Never trust browser clinic_id.
2. **I1 Routing** — Auto-dispatch longest-idle (RR fallback) on Available. 1 call ≤ 1 assignee; 1 staff ≤ 1 Ringing/InCall. Ring ~15s; timeout/reject/disconnect release; end → Available + dispatch queue head. No hunt-group claim MVP.
3. **I2 Embed** — API ≠ Widget. Public site_key (not secret) + domain allowlist + rate limit + short-lived visitor session. Staff JWT separate. LiveKit secrets never in browser. Media after Accept only.
4. **I3 Recording** — Mode before/during call (None/AudioOnly/Video); default None or AudioOnly not Video. Retention after record. Failures must not kill live call. Object storage interface for scale; disk VPS = dev only.

## Closed decisions (do not re-open without explicit change)
- Recording access: visitor no; staff metadata no default download; manager/admin clinic download/delete; audit create/download/delete; consent in model/API from day one.
- Hours: outside → Closed immediately (no queue); inside → queue + dispatch + visitor_timeout → NoAgent/Timeout. Config per clinic + defaults.
- Presence: Offline/Available/Ringing/InCall + heartbeat lease; no Away MVP.
- Widget: visitor floating button + Waiting/Ringing/Connected/Ended + basic AV; staff portal/console first. Branding: logo, name, few colors. No group/transfer/barge. getUserMedia only when entering media.
- RecordingPolicy: mode, retentionDays (configurable, default config 30 for lifecycle test), access. Not hardcode days in domain logic.
- 50 concurrent = ~50 calls; recording benchmarks R1 (50+480p15 video record), R2 (50 audio record), R3 mix later. Scale egress workers separately from 2 vCPU app node. Don’t infer recording cap from current media load tests.

## Implement order (strict)
isolation → presence+agent state → routing/queue → visitor API → staff API/console → embed widget → recording policy → object storage+async → recording capacity R1/R2/R3

## Working rules
1. Read PoC + TASK-003 before coding.
2. Small PRs; isolation + one-staff-one-call tests before widgets.
3. No secrets in git.
4. Prefer product/invariant/AC separation in docs and PRs.

## Your task now
> [ĐIỀN: e.g. implement Phase 0 clinic isolation]

Start with: (1) 5–8 bullet understanding, (2) confirm scope, (3) concrete next steps.
```
