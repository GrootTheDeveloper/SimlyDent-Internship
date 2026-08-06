# TASK-003 Phase 2 — Embed + multi-clinic evidence (VPS)

| Field | Value |
|-------|--------|
| **Date** | 2026-08-06 18:19 +07:00 |
| **API / widget host** | `https://103.28.32.118.sslip.io` |
| **Baseline commit (local)** | `e2890c5` (+ PR-E uncommitted harness/docs/suite fix at capture time) |
| **Operator** | PoC automation session |
| **Harness model** | Fake clinic hosts on ports 5174/5175; **remote** widget from VPS |

## 1. Automated suite (final close-out)

**Command (no `-SkipSlow`):**

```powershell
.\scripts\run-test-suite.ps1 -ApiUrl "https://103.28.32.118.sslip.io" -SkipSignalR
```

| Flag | Used? | Reason |
|------|-------|--------|
| `-SkipSlow` | **No** | Forbidden for final Phase 2 evidence |
| `-SkipSignalR` | **Yes** | Local machine has no `dotnet` for SignalR probe helper; HTTP isolation still full |

**Result: PASS** (exit 0)

| Step | Suite | Result |
|------|-------|--------|
| 1/6 | smoke-test | PASS — 40 checks |
| 2/6 | clinic-isolation-test (HTTP, SkipSignalR) | PASS |
| 3/6 | routing-test (includes ring-timeout ~15s+) | PASS — 63 checks |
| 4/6 | embed-session-test | PASS — 22 checks (includes 4-way origin) |
| 5/6 | embed-isolation-test | PASS — 36 checks |
| 6/6 | embed-lifecycle-test (stale waiting ~38s) | PASS — 11 checks |

Closing line: `All suites passed against https://103.28.32.118.sslip.io`

**Suite runner fix (PR-E):** `run-test-suite.ps1` previously could stop after smoke when child scripts omitted `exit 0` and leftover `$LASTEXITCODE` was non-zero/null. Now resets `$LASTEXITCODE` per step.

## 2. Origin binding 4-way

**Command:**

```powershell
.\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io" -ProbeOnly
```

| Case | Expected | Actual |
|------|----------|--------|
| Origin A (`http://127.0.0.1:5174`) + `pk_clinic_a` | 200 | **200** |
| Origin B (`http://127.0.0.1:5175`) + `pk_clinic_b` | 200 | **200** |
| Origin B + `pk_clinic_a` | 403 | **403** |
| Origin A + `pk_clinic_b` | 403 | **403** |

**Result: PASS (4/4)** — symmetric `site_key ↔ allowed origin`.

Also mirrored in embed-session-test (`origin B + site_key A 403`, `origin A + site_key B 403`).

## 3. Browser E2E

### Architecture used

```text
http://127.0.0.1:5174 = fake website Clinic A
  └─ remote https://103.28.32.118.sslip.io/widget/embed.js
     data-site-key=pk_clinic_a
     data-api-base=https://103.28.32.118.sslip.io

http://127.0.0.1:5175 = fake website Clinic B
  └─ remote widget (same host) · pk_clinic_b

Staff portal = https://103.28.32.118.sslip.io/  (JWT A1)
```

Harness: `.\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io" -ProbeAndServe`  
Protocol: [docs/phase2-browser-e2e-protocol.md](../docs/phase2-browser-e2e-protocol.md)

### E2-1 Happy path (control plane — automated)

Covered by **embed-isolation-test** happy path against VPS:

| Step | Result |
|------|--------|
| Embed session Origin A + key A | PASS |
| POST /embed/calls → Queued/Ringing | PASS |
| Staff Accept (assigned) | PASS |
| Visitor GET status Accepted | PASS |
| POST …/token after Accept (join credential) | PASS |
| Token has LiveKit URL | PASS (`wss://103.28.32.118.sslip.io`) |
| Visitor end | PASS |

**Browser UI + media tracks (camera/mic):** not executed in this automation session (no headed browser driver). Operator can complete visual steps with harness + staff portal using the protocol checklist. Camera-optional path already implemented in PR-D.

### E2-2 Cross clinic isolation

| Check | Result |
|-------|--------|
| clinic-b cannot read clinic-a embed call | PASS (404) — embed-isolation |
| clinic-a cannot read clinic-b embed call | PASS (404) |
| other session same clinic 404 | PASS |
| staff B1 HTTP isolation (clinic isolation suite) | PASS |
| 4-way origin | PASS |

## 4. Security spot-check

- [x] `clinicId` from site_key / embed session claims only (not body clinic spoof)
- [x] 4-way origin binding (A+A, B+B, B+A, A+B)
- [x] **No LiveKit API key / API secret / signing secret** in widget public assets (embed.js is loader only; secrets stay server-side)
- [x] **Short-lived participant join token after Accepted is expected** (embed-isolation token after accept → 200; before accept → 409)
- [x] B cannot access A call (embed + staff HTTP isolation)
- [x] Embed JWT cannot call staff overview (`/api/agents` → 401)
- [x] Staff JWT rejected on `POST /embed/calls` (401)

## 5. DoD Phase 2

| Criterion | Status |
|-----------|--------|
| Demo clinic-a creates queue call without staff password | **PASS** (embed API + harness model) |
| Staff clinic-a assign + Accept; media path token works | **PASS** (token after Accept); browser media optional operator |
| clinic-b site_key/staff cannot access clinic-a embed call | **PASS** |
| Widget never receives LiveKit API/signing secret | **PASS** (join token only after Accept) |
| `run-test-suite.ps1` + embed suites PASS on VPS | **PASS** (full, no SkipSlow; SkipSignalR only) |
| README snippet for clinic integration | **PASS** (README + protocol + harness) |

## 6. Known limits

- Same-host paths `/widget/demo-a.html` vs `demo-b.html` are **UI demos only**, not multi-origin proof.
- SignalR realtime isolation probe skipped here (`dotnet` missing on operator machine); prior Phase 0 evidence covers SignalR when probe available.
- Single-node PoC; no RecordingPolicy / S3 / working-hours Closed productization.
- Headed browser media E2E not recorded as screenshot in this file.

## 7. Commands quick reference

```powershell
# 4-way origin
.\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io" -ProbeOnly

# Fake clinic websites + remote widget
.\scripts\serve-embed-demo-origins.ps1 -ApiBase "https://103.28.32.118.sslip.io" -ProbeAndServe

# Full suite close-out (no SkipSlow)
.\scripts\run-test-suite.ps1 -ApiUrl "https://103.28.32.118.sslip.io" -SkipSignalR
```
