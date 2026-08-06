# Performance test plan — LiveKit 1:1 PoC

**Status:** Ready to execute (manual + existing telemetry).  
**Scope:** Qualify sustained 1:1 web video on the current PoC stack (local LAN and/or VPS multi-network).  
**Non-scope:** Invented production capacity SLAs, multi-party, load-generator farm, TCO numbers (see `workload-scenarios.md`).

Related artifacts:

- Runtime quality panel + sample upload: frontend `main.js` quality monitor → `POST /api/calls/{id}/quality/samples`
- Export: `GET /api/calls/{id}/quality/export?format=csv|json`
- Prior evidence: [../evidence/2026-08-05-performance-recording.md](../evidence/2026-08-05-performance-recording.md)
- Scenario matrix IDs: [../../../docs/poc-test-matrix.md](../../../docs/poc-test-matrix.md) (F-01, F-02, …)

---

## 1. Goals

| Goal | Question this plan answers |
|---|---|
| G1 Sustained call | After a continuous ~**5 minute** 1:1 call, is media still usable (no hard freeze, recoverable ICE)? |
| G2 Quality envelope | What resolution / fps / bitrate / loss / RTT / jitter do we observe at start, mid, end? |
| G3 Resource sanity | Do browser + SFU host stay within reasonable CPU/RAM for a single concurrent call? |
| G4 Network path | Host/srflx/relay — which candidate path is used (LAN vs cross-network)? |

**Pass bar for PoC:** observational “good enough,” not a contractual SLA. Production targets remain **TBD** until product owners lock workload inputs.

---

## 2. Metrics to collect

### 2.1 Media / WebRTC (required)

Sample at least at **t≈30s**, **t≈2.5min**, **t≈5min** (and on any visible freeze). Prefer continuous client sampling every **5–10s** via the in-app quality panel (already posts batches).

| Metric | Where | Notes |
|---|---|---|
| Incoming / outgoing resolution (W×H) | Quality panel + export | Target config 720p; portrait may be 720×1280 |
| FPS in / out | Quality panel | Observe drops under load |
| Bitrate in / out (kbps) | Quality panel | Config max publish ~2.5 Mbps |
| Packet loss % | Quality panel | Watch sustained >2% |
| Jitter (ms) | Quality panel | Spike vs steady |
| RTT / currentRoundTripTime (ms) | Quality panel | Cross-network / VPS path |
| Codec | Quality panel | Typically VP8 publish |
| qualityLimitationReason | Quality panel | `none` / `bandwidth` / `cpu` |
| ICE candidate types (local/remote) | Quality panel connection block | host vs srflx vs relay |
| Freeze count / freeze duration delta | If exposed in samples | Correlate with user-visible freezes |

### 2.2 Application / server (recommended)

| Metric | How |
|---|---|
| Call state transitions | Backend logs / UI (Ringing → Accepted → Ended) |
| SignalR disconnects | Browser console + hub reconnect |
| LiveKit room participants active | `docker compose logs livekit` |
| Host CPU / memory (backend, livekit, browser) | Task Manager / `docker stats` during the 5‑min window |
| Packet path | Optional: chrome://webrtc-internals (export) |

### 2.3 Explicitly not hard SLAs

Do **not** treat the following as pass/fail production gates until workload owners set numbers:

- Concurrent call capacity of the VPS  
- P95 bitrate or “must stay 720p for 5 minutes on 4G”  
- Monthly storage/TURN cost  

Record raw observations; mark capacity conclusions as **TBD**.

---

## 3. Scenarios

| ID | Scenario | Duration | Networks | Devices (example) | Success observation (PoC) |
|---|---|---|---|---|---|
| PERF-01 | Sustained continuous call | **~5 min** | Same LAN (local stack) | Desktop Chrome ↔ Desktop Edge/Chrome | A/V both ways whole window; end cleanly; quality samples ≥3 |
| PERF-02 | Sustained continuous call | **~5 min** | Different networks (VPS) | Desktop ↔ phone or second site | Same as PERF-01; note candidate type (relay expected if restrictive NAT) |
| PERF-03 | Start / steady / end sampling only | 5 min | One locked config | Same as PERF-01 | Export CSV/JSON contains samples spanning the call |
| PERF-04 | Weak-network stress (optional) | 3–5 min | Throttle or poor Wi‑Fi | Desktop ↔ Desktop | Call stays up or fails gracefully; limitation reason logged — not required to hold HD |
| PERF-05 | Back-to-back calls | 3× ~2 min | Same as PERF-01 | Same pair | No stuck UI (select user / online / hangup); no ghost busy |

Primary deliverable for stakeholder demos: **PERF-01** then **PERF-02**.

---

## 4. Procedure

### 4.1 Preconditions

1. Stack healthy: `GET /health` → 200; frontend reachable.  
2. Two demo accounts same tenant (e.g. A1 / A2), password `Demo@123`, both **online**.  
3. Camera/mic granted; prefer wired or stable Wi‑Fi for PERF-01 baseline.  
4. For VPS path: domain HTTPS, UDP media/TURN ports open (see `vps-deploy.md`).  
5. Optional: `docker stats` terminal open on host.

### 4.2 Steps (PERF-01 / PERF-02)

1. Login A1 and A2 in two browsers (or two devices). Confirm green online dots.  
2. A1 calls A2 → accept → both media paths green (remote video + local PiP).  
3. Start a wall-clock timer (**5:00**).  
4. At **0:30**, open quality badge (HD/SD/LOW) on **both** sides; screenshot or note resolution/fps/bitrate/loss/RTT.  
5. Leave call idle (talk/move occasionally so A/V is real). Do not refresh unless testing reconnect.  
6. At **2:30** and **4:50**, repeat quality capture both sides.  
7. At **5:00**, end call from one side; confirm other side leaves; both UIs allow a new call.  
8. Export quality: while still authenticated as a participant of that call id (or immediately after end while session known):  
   - UI export if available, or  
   - `GET /api/calls/{callId}/quality/export?format=csv` with Bearer token  
9. Save artifacts under `evidence/` with run id, e.g. `evidence/perf-PERF-01-YYYYMMDD/`.

### 4.3 Tools (use what already ships)

| Tool | Role |
|---|---|
| In-app quality panel | Primary live metrics |
| Quality samples API + CSV/JSON export | Durable run log |
| Browser DevTools Performance / Memory | Optional deep dive |
| chrome://webrtc-internals | ICE/candidate proof |
| `docker stats` | SFU/API container CPU/RAM |
| LiveKit Prometheus `:6789/metrics` | SFU-observed Mbps in/out, pkt/s, loss% (auto in `media-load-test.ps1`) |
| `scripts/smoke-test.ps1` | API regression only (not a media load test) |
| `scripts/media-load-test.ps1` | Concurrent CLI rooms + Prometheus bitrate/loss (not browser path) |

### 4.4 Sampling template (copy per run)

```text
Run ID:
Scenario: PERF-0x
Date/time:
Stack: local | VPS (URL)
Caller: user / device / OS / browser
Callee: user / device / OS / browser
Network notes:

t=0:30  | side A | res | fps | br_in | br_out | loss% | rtt | limit | candidate
t=0:30  | side B | ...
t=2:30  | ...
t=4:50  | ...
t=5:00  | end success? Y/N | issues:
Host docker stats (peak): livekit CPU% RAM; backend CPU% RAM
Subjective A/V: OK / soft / freeze once / unusable
```

---

## 5. Pass / observe criteria (PoC)

| Check | Good enough for PoC | Investigate |
|---|---|---|
| Continuity | Call remains connected ~5 min without forced reload | Disconnect needing full re-login |
| Usability | Speech intelligible; face recognizable most of the time | Black video, permanent freeze, no audio |
| Hangup | End works; contacts selectable again | Stuck `isCallActive`, offline wrong |
| Telemetry | ≥1 sample batch stored; export non-empty | Empty quality summary after active call |
| Resources (single call) | Host not thrashing; browser tab responsive | LiveKit container pegged 100% CPU on 1 call |
| Cross-network | Media connects via host/srflx/relay | UI works but media never arrives (ICE fail) |

**Do not fail the PoC** solely because bitrate dipped below HD on mobile data — record `qualityLimitationReason` and path instead.

---

## 6. Execution checklist (operators)

**Repetitions:** PoC dùng **N = 3 hoặc 4** mỗi scenario (không 1 lần). Ghi min / p50 / avg / max hoặc pass x/N. Protocol đầy đủ: [real-world-test-protocol.md](real-world-test-protocol.md).

- [ ] PERF-01 same-LAN 5 min × **3–4** + aggregate sheet + CSV export  
- [ ] PERF-02 multi-network 5 min × **3–4** (VPS) + candidate types  
- [ ] PERF-05 back-to-back UI sanity  
- [ ] Optional PERF-04 throttle once  
- [ ] CLI media: `.\scripts\run-repeated-media-load.ps1 -Repetitions 4`  
- [ ] Link evidence folder from daily log / report  

---

## 7. After this plan

1. Feed measured avg/P95 duration and bitrate into `workload-scenarios.md` **only when product owns the numbers**.  
2. If sustained call shows high loss on corporate Wi‑Fi, prioritize TURN/path docs over raising bitrate.  
3. Recording load is a **separate** plan (Egress CPU + disk); do not enable recording during PERF-01 baseline unless explicitly comparing dual load.
