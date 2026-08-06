# Recording feature + storage optimization — development plan

**Status:** Phased plan (implementation not required to close residual-debt goal).  
**Current PoC:** LiveKit Egress room composite → local MP4 under `recordings/`; start/stop/download via authenticated API; cross-tenant download blocked.

Evidence baseline: [../evidence/2026-08-05-performance-recording.md](../evidence/2026-08-05-performance-recording.md)  
Code: `LiveKitEgressService.cs`, recording routes in `Program.cs`, volume mount in compose.

---

## 1. Current gaps (honest inventory)

| Area | PoC today | Production gap |
|---|---|---|
| Start / stop / download | Yes (JWT participant only) | RBAC roles (admin vs agent), audit who downloaded |
| Consent | Confirm dialog only | Dual-party consent, legal text, opt-out, clinic policy |
| Storage backend | Host bind mount `./recordings` | Object storage (S3/MinIO), multi-node safe |
| Retention / deletion | Never auto-deletes | TTL job, legal hold, soft-delete |
| Encryption | Disk whatever host provides | KMS / SSE-S3 / app-level envelope optional |
| Metadata | Filename + in-memory call session | Durable DB: callId, tenant, participants, size, hash, status |
| Cost / size control | Full composite MP4 ~sample 9s ≈ 3.3 MB | Codec preset, audio-only option, lifecycle tiers |
| Completeness | Best-effort stop on hangup | Webhook reconcile, orphan cleanup |
| Multi-tenant isolation | Path not guessable + API 404 | Bucket prefix per tenant + IAM |

---

## 2. Size and cost drivers (for planning, not invented SLAs)

From PoC sample (~9.2 s composite H.264 720p + AAC ≈ 3.3 MB):

```text
rough_bytes_per_minute ≈ 3.3e6 / (9.2/60)  ≈ 21–22 MB/min  (order-of-magnitude only)
```

Drivers to track when product sets retention:

| Driver | Effect |
|---|---|
| Resolution / fps / bitrate preset | Linear-ish with video bitrate |
| Composite layout vs track egress | Composite = fixed canvas encode cost |
| Audio-only recording | Order of magnitude smaller |
| Retention days | `storage ≈ minutes_recorded × bytes_per_min × retention` |
| Region / egress download | Object GET + CDN costs |
| Concurrent Egress workers | CPU/RAM on recorder host (image is heavy) |

Use `workload-scenarios.md` formulas; fill numbers only with owner-approved inputs.

---

## 3. Target architecture (phased)

```text
Browser ──JWT──► Call API ──► LiveKit Egress
                      │              │
                      │              ▼
                      │         Object storage (tenant/prefix/key)
                      ▼
                 Metadata DB (status, size, checksum, consent ids)
                      │
                      ▼
              Retention worker + audit log
```

PoC stays single-node disk until Phase B.

---

## 4. Implementation phases

### Phase A — Productize current disk path (low risk)

**Goal:** Safe enough for controlled internal pilots, still local disk.

1. **Consent model (API + UI)**  
   - `recordingConsent: { callerAccepted, calleeAccepted, policyVersion, at }` on call session  
   - Start recording only if policy satisfied (e.g. both true, or one-party clinic policy flag)  
   - Persist consent text version in metadata  
2. **Durable recording metadata**  
   - Table/store: `RecordingId`, `CallId`, `TenantId`, `FileName`/`ObjectKey`, `Status`, `Bytes`, `CreatedAt`, `CompletedAt`, `CreatedBy`  
   - Survive backend restart (today in-memory session loses download after recycle)  
3. **Hangup / crash reconcile**  
   - On end: stop egress if Recording  
   - Periodic job: list egress + files vs metadata; mark Failed/Complete  
4. **Download audit**  
   - Log userId, tenantId, recordingId, timestamp, result  
5. **Retention skeleton**  
   - Config `RECORDING_RETENTION_DAYS` (e.g. 30)  
   - Nightly delete files older than retention when status Complete and no legal hold  

**Exit criteria:** E2E script still green; restart backend → metadata still finds file; cross-tenant still 404; consent blocks start when incomplete.

### Phase B — Object storage + lifecycle

**Goal:** Multi-instance API, disk not the system of record.

1. Configure LiveKit Egress **S3-compatible** output (MinIO on VPS or cloud bucket)  
2. Keys: `{tenantId}/{yyyy}/{mm}/{callId}/{recordingId}.mp4`  
3. API download: **presigned GET** (short TTL) instead of streaming through app when possible  
4. Bucket lifecycle rules: transition to infrequent access after N days; expire after retention  
5. Optional server-side encryption (SSE-S3 / SSE-KMS)  

**Exit criteria:** Recording works with empty local `recordings/` volume; presign download works for participant only.

### Phase C — Optimization & ops

1. **Codec / profile matrix**  
   - Default: 720p composite for clinical review  
   - Economy: 480p or lower bitrate preset  
   - Audio-only mode for compliance-lite use cases  
2. **Compression / post-process (optional)**  
   - Transcode offline to smaller long-term archive codec if legal allows  
3. **Quota per tenant**  
   - Max concurrent recordings, max GB  
4. **Observability**  
   - Metrics: start latency, fail rate, bytes written, egress CPU  
5. **Backup / DR**  
   - Cross-region replication policy if required by business  

**Exit criteria:** Documented profile table + runbook; alert on Failed rate.

### Phase D — Legal / security hardening (stakeholder-driven)

1. Clinic-approved consent copy + retention schedule  
2. Access reviews (who may play/download)  
3. Encryption-at-rest proof for auditors  
4. Data subject deletion workflow (GDPR-like)  

Not started until legal/product owners sign policy inputs.

---

## 5. API / UX shape (target, incremental)

| Action | PoC | Target |
|---|---|---|
| Start | POST `.../recording/start` | Require consent claims; return 409 if policy incomplete |
| Stop | POST `.../recording/stop` | Same + finalize metadata bytes/hash |
| Status | Call view fields | GET `.../recordings` list for call |
| Download | GET `.../recording/file` | Presigned URL or ranged file; audit |
| Delete | None | Admin DELETE with audit + retention override |

UI: dual consent banners; “Đang ghi” already exists; add retention hint (“file kept N days”).

---

## 6. Storage lifecycle options (decision table)

| Option | Pros | Cons | When |
|---|---|---|---|
| Local disk only | Simple | Single host, no HA, backup manual | PoC / Phase A pilot |
| MinIO on same VPS | S3 API, cheap lab | Ops burden, still one site | Phase B lab |
| Cloud object storage | Lifecycle, SSE, multi-AZ | Egress cost, vendor | Phase B production-ish |
| Hybrid (hot disk → cold object) | Fast finalize | Complexity | High volume clinics |

Recommended path: **A (disk + metadata + retention) → B (MinIO or cloud S3) → C (profiles)**.

---

## 7. Security checklist (must not regress)

- [x] Participant JWT required (no `X-User-Id` spoof)  
- [x] Cross-tenant download 404  
- [ ] Consent before start (Phase A)  
- [ ] Audit download/delete (Phase A)  
- [ ] Object keys not enumerable (random id + auth)  
- [ ] Short-lived presign URLs (Phase B)  
- [ ] Encryption at rest documented (Phase B/D)  

---

## 8. Test plan hooks

| Test | Tool / method |
|---|---|
| Start/stop/file + cross-tenant | `scripts/recording-e2e-test.ps1` (JWT) |
| Consent block | New unit/API cases when Phase A lands |
| Retention job | Seed old file + run worker dry-run |
| Presign expiry | Clock skew test Phase B |
| Perf with recording on | Optional PERF run with Egress; expect higher host CPU |

Do not gate residual-debt goal on full Egress image pull if environment cannot run recording profile; plan + JWT script readiness is enough.

---

## 9. Suggested ticket order (engineering backlog)

1. Recording metadata store + restart-safe download  
2. Consent flags + UI + API enforcement  
3. Retention job + config  
4. Download audit log  
5. S3/MinIO egress output + presign  
6. Economy/audio profiles  
7. Quotas + metrics  

Each ticket should reference this doc section and leave production legal policy fields as **TBD owner**.
