# TASK-003 Phase 3 — Recording policy, storage, retention, capacity

| Field | Value |
|-------|--------|
| **Date** | 2026-08-06 |
| **Git SHA** | `0eb2bce` on `main` |
| **API** | `https://103.28.32.118.sslip.io` |
| **Operator** | Automated goal session |

## Phase 3a — Policy / consent / ACL

**Command:**
```powershell
.\scripts\recording-policy-test.ps1 -ApiUrl "https://103.28.32.118.sslip.io"
```
**Result: 64 checks PASS, 0 FAIL** (log: scratch `phase3a-recording-suite.log`)

| Check | Result |
|-------|--------|
| Default clinic policy `None` | **PASS** |
| AllowedModes includes AudioOnly + Video | **PASS** |
| Call snapshot `recordingMode=None` at create | **PASS** |
| CallView has **no** `recordingEgressId` / `recordingFileName` | **PASS** |
| Start while None → 409 | **PASS** |
| Start without consent / Declined → 409 | **PASS** |
| Consent Granted + actor/timestamp | **PASS** |
| Staff `canDownload=false` / file → **404** (pre and post Complete) | **PASS** |
| Visitor download after Complete → **404** | **PASS** |
| B-MGR on clinic-a Complete → **404** | **PASS** |
| **A-MGR plant Complete + download 200 (real bytes)** | **PASS** |
| **A-MGR delete + idempotent + audit Download/Deleted** | **PASS** |
| A-MGR / B-MGR role Manager; agents/ready **403** | **PASS** |
| AudioOnly start after gates → **200** | **PASS** |
| Stop without archive file → **503 Failed** (not false Complete) | **PASS** |
| End call still **200** after recording fail | **PASS** |

Invariants:

```text
Recording failure ≠ Call failure   (503 on stop/start leaves call endable)
Recording authorization ≠ Call participant authorization  (staff participant ≠ download)
```

## Phase 3b — Storage abstraction

| Item | Status |
|------|--------|
| `IRecordingStorage` | **Implemented** (`LocalRecordingStorage`, `S3RecordingStorage`) |
| Key layout | `clinic/{clinicId}/calls/{callId}/{recordingId}.mp4` — **PASS** in suite |
| Complete only if object exists | **Fixed** in `0eb2bce` (stop/end never set Complete without archive) |
| Plant + OpenRead path | Manager plant-complete writes object; download returns body |
| Config | `RECORDING_STORAGE=local` default; MinIO profile optional |
| Frontend secrets | None |

## Phase 3c — Retention + audit

| Item | Result |
|------|--------|
| Plant Complete with `ageDays=400` then retention-run | **deleted=1**, status **Deleted** |
| Audit `RecordingExpired` | **PASS** |
| Staff retention-run | **403** |
| Audit download/delete events | **PASS** |

## Phase 3d — Capacity

**Infrastructure:** same 2 vCPU-class VPS as media PoC; Egress co-located.

| Scenario | Result |
|----------|--------|
| R1 50× Video 480p15 | **Not executed at N=50** — would overload single-node Egress + 2 vCPU (prior media ceiling already soft-max ~30 concurrent **calls** without recording). |
| R2 50× AudioOnly | Same — requires **horizontal Egress workers**, not app VPS alone. |
| R3 mix | Deferred until worker pool exists. |

**Measured (this session):** sequential AudioOnly + Video **start** requests succeed against LiveKit Egress on this host; full finalize/download depends on Egress file landing under shared volume.

**Recommendation:** split Egress workers; record capacity on a recording pool separate from signaling/API; re-run R1/R2 with N ramp 1→5→10 before 50.

## Regression

Phase 0–2 suite should be re-run when public HTTPS gateway is stable from the operator network. Backend build verified by **successful container start** (`dotnet LiveKitPoc.Api`) after image rebuild on VPS.

## Known limits

- Public `https://*.sslip.io` briefly refused during gateway recreate; tests used in-cluster backend IP.
- Video stop→file finalize can fail (503) without killing call.
- MinIO path implemented but not mandatory for default deploy.
- Outside-hours `Closed` still out of Phase 3 scope.

## Files

- Backend: `RecordingPolicyRegistry`, `RecordingAuthorization`, `RecordingStorage`, `RecordingRetentionService`, `RecordingAuditService`
- Scripts: `scripts/recording-policy-test.ps1` (wired in `run-test-suite.ps1` step 7/7)
- UI: staff recording mode/consent flow; widget consent checkbox
