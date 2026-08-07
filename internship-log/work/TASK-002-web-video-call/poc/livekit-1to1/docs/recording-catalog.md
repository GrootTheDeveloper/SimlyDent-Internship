# Recording catalog (R-pg-core)

PostgreSQL is the durable source of truth for recording **metadata**. Object Storage holds **bytes**. Call session memory remains the live-call control plane only.

## Tables

### `recordings`

Business / lifecycle row per logical recording.

| Column | Role |
|--------|------|
| `id` | `recording_id` |
| `clinic_id`, `call_id` | isolation boundary |
| `egress_id` | LiveKit egress id once accepted |
| `status` | state machine (see below) |
| `mode` | Video / AudioOnly snapshot |
| `retention_until` | business delete eligibility |
| `error` | last failure |
| caller / staff / call / consent snapshot | Manager library labels after restart |

### `recording_objects`

Physical objects for one recording (multi-rendition ready).

| Column | Role |
|--------|------|
| `recording_id` + `kind` | unique (default kind: `Composite`) |
| `storage_key` | S3/local key |
| `bytes`, `duration_ms`, `etag`, `codec` | filled when Ready |

Later: `Playback`, `Archive`, raw tracks without schema rewrite.

## Status machine

```text
Requested → Recording → Finalizing → Ready → DeletePending → Deleted
                 ↘           ↘
                  Failed ←────┘
```

UI mapping (PoC frontend strings):

| Ledger | UI (`CallSession` / list) |
|--------|---------------------------|
| Requested | Starting |
| Recording | Recording |
| Finalizing | Stopping |
| Ready | Complete |
| Deleted | Deleted |
| Failed | Failed |

## Configuration

| Env | Default | Notes |
|-----|---------|--------|
| `RECORDING_CATALOG` | `postgres` (compose) / `auto` | `postgres` \| `memory` \| `auto` |
| `POSTGRES_HOST` | `postgres` | |
| `POSTGRES_PORT` | `5432` | |
| `POSTGRES_DB` | `simlydent` | |
| `POSTGRES_USER` | `simlydent` | |
| `POSTGRES_PASSWORD` | `simlydent` | change on VPS |
| `RECORDING_DB` | — | optional full connection string override |

Lab without Postgres: `RECORDING_CATALOG=memory`.

## Dual-write rules

1. **Insert ledger `Requested` before StartEgress** — so restart never loses “we tried to record”.  
2. Call session fields still updated for live UI / SignalR.  
3. `GET /api/recordings` reads **catalog first** (survives API restart).  
4. Download/delete resolve storage key from catalog when call dict is gone.

## Health

`GET /health` includes:

```json
{ "status": "ok", "recordingCatalog": "postgres", "recordingStorage": "local" }
```

## Direct S3 egress (R-s3-egress)

| Env | Meaning |
|-----|---------|
| `EGRESS_OUTPUT=local` | Default lab: Egress writes `/out`, API copies into storage |
| `EGRESS_OUTPUT=s3` | Egress uploads to S3-compatible bucket using `filepath` = clinic storage key |
| `RECORDING_STORAGE=s3` | API uses Head/Get/Delete against same bucket (MinIO fixture or other) |

When `EGRESS_OUTPUT=s3`, **do not** PutObject the video body from ASP.NET. Complete/Ready only after `ExistsAsync` (HeadObject).

MinIO remains an **integration fixture**; production picks SeaweedFS/Ceph/etc. via S3 endpoint env only.

**TLS:** production profiles should use HTTPS object endpoint; plain `http://minio:9000` is lab-only.

## Next

- **R-egress-finalize** — Stop → Finalizing immediate; webhook + reconcile → Ready  
- **R-presign** — signed GET  
- **R-retention** — DB-driven DeletePending worker  
