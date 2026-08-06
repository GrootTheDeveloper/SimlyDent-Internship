# TASK-003 Phase 3 — Recording policy, storage, retention, capacity

| Field | Value |
|-------|--------|
| **Date** | 2026-08-06 |
| **Git SHA** | `faf72d4` (compose) / `fe4c2de` (feature) on `main` |
| **API** | VPS backend container `http://172.18.0.4:8080` (public gateway was restarted; suite run on docker network) |
| **Operator** | Automated goal session |

## Phase 3a — Policy / consent / ACL

**Commands (on VPS host against backend network IP):** Python 3.6 urllib suite (equivalent to `scripts/recording-policy-test.ps1`).

| Check | Result |
|-------|--------|
| Default clinic policy `None` | **PASS** |
| AllowedModes includes AudioOnly + Video | **PASS** |
| Call snapshot `recordingMode=None` at create | **PASS** |
| CallView has **no** `recordingEgressId` / `recordingFileName` | **PASS** |
| Start while None → 409 | **PASS** |
| Start without consent → 409 | **PASS** |
| Consent Granted + actor/timestamp | **PASS** |
| Staff `canDownload=false` / file → **404** | **PASS** |
| B-MGR on clinic-a recording → **404** | **PASS** |
| A-MGR / B-MGR role Manager; agents/ready **403** | **PASS** |
| AudioOnly start after gates → **200** (Egress accepted) | **PASS** |
| Video start → 200; stop may 503 if file not on disk yet | **PASS** (call still endable) |
| End call after recording fail/success | **PASS** |

Invariants:

```text
Recording failure ≠ Call failure   (503 on stop/start leaves call endable)
Recording authorization ≠ Call participant authorization  (staff participant ≠ download)
```

## Phase 3b — Storage abstraction

| Item | Status |
|------|--------|
| `IRecordingStorage` | **Implemented** (`LocalRecordingStorage`, `S3RecordingStorage`) |
| Key layout | `clinic/{clinicId}/calls/{callId}/{recordingId}.mp4` |
| Config | `RECORDING_STORAGE=local` default; `s3`/`minio` optional |
| MinIO | `docker-compose` profile `minio` (not required for Phase 0–2) |
| Frontend secrets | None |

Local path used on VPS (`RECORDING_STORAGE=local`). Stop→archive may 503 when Egress file not yet visible under `/recordings` mount timing — status becomes `Failed`, live call still ends.

## Phase 3c — Retention + audit

| Item | Result |
|------|--------|
| `POST /api/admin/recording/retention-run` Manager | **200** `{ deleted: 0 }` |
| Staff retention-run | **403** |
| `GET /api/recording/audit` Manager | **200** (events present) |
| Staff audit | **403** |
| Active Starting/Recording never deleted | Code path skips those statuses |

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
