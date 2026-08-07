# Phase C Direct S3 lab evidence

**Date (UTC):** 2026-08-07  
**Commit:** `bda6be5` (Direct S3 implementation + scaffolding)  
**Base URL:** `https://103.28.32.118.sslip.io`  
**S3 host:** `https://s3.103.28.32.118.sslip.io`  
**Proof type:** Real LiveKit Egress recording (not plant). Object key co-located with `EG_*.json` egress metadata.

## Config (lab, then rolled back)

| Key | Lab value |
|-----|-----------|
| `RECORDING_STORAGE` | `s3` |
| `EGRESS_OUTPUT` | `s3` |
| `S3_PUBLIC_ENDPOINT` | `https://s3.103.28.32.118.sslip.io` (origin-only, no path prefix) |
| `S3_INTERNAL_ENDPOINT` | `http://minio:9000` |
| `S3_BUCKET` | `simlydent-recordings` |
| `S3_ACCESS_KEY` | `simlydent-lab` (**≠** MinIO root `minioadmin`) |
| Caddy | `s3.DOMAIN { reverse_proxy minio:9000 }` (Host/URI preserved) |

Lab health (`GET /health` internal):

```json
{"status":"ok","recordingCatalog":"postgres","recordingStorage":"s3","egressOutput":"s3","s3PublicConfigured":true,"supportsPresignedGet":true}
```

Anonymous `GET https://s3.…/` → **403** (private bucket / no public list).

Note: code only **warns** if `minioadmin` is used as app key; non-root was applied via bootstrap + env evidence, not hard fail-fast.

## WRITE path (real Egress → HTTPS S3 → MinIO)

| Field | Value |
|-------|--------|
| Call ID | `da0eba14-4fdd-4ac4-94a6-bb5ef8530ac4` |
| Recording ID | `8c300e93eff04060a53c0c35250aeac3` |
| Egress ID | `EG_2ptuRS78PHL7` (from object `EG_2ptuRS78PHL7.json` next to mp4) |
| Status | **Complete** / canDownload true (catalog Ready mapped to UI Complete) |
| Storage key | `clinic/clinic-a/calls/da0eba144fdd4ac494a6bb5ef8530ac4/8c300e93eff04060a53c0c35250aeac3.mp4` |
| Object size | **3.4 MiB** (MinIO `mc ls`) |

```text
[2026-08-07 06:53:52 UTC] 3.4MiB STANDARD clinic/clinic-a/calls/.../8c300e93....mp4
[2026-08-07 06:53:52 UTC]  469B STANDARD clinic/clinic-a/calls/.../EG_2ptuRS78PHL7.json
```

Staff flow: call Accepted + Video + consent Granted → start → stop → Finalizing async → Complete/Ready after object present.

Control plane: ASP.NET started/stopped egress and wrote catalog; video bytes landed via **Egress direct S3**, not API `SaveFromLocalFileAsync` happy path.

## READ path (presign → browser/object GET)

| Field | Value |
|-------|--------|
| `GET .../recording/download-url` | HTTP 200 |
| `mode` | **presign** |
| Host | **s3.103.28.32.118.sslip.io** |
| Path | `/simlydent-recordings/clinic/clinic-a/calls/.../8c300e93....mp4` |
| Credential in URL | `simlydent-lab` (app key) |
| Presigned GET | **HTTP 200**, **bytes=3588913** |

Backend served small JSON only for download-url; media GET hit Object Storage host (not `Results.File` proxy).

## SECURITY

| Check | Result |
|-------|--------|
| B-MGR download-url same call | **HTTP 404** (`cross_clinic_http=404`) |
| Bucket anonymous list | **403** on `https://s3.DOMAIN/` |
| App credential ≠ root | `S3_ACCESS_KEY=simlydent-lab` vs `MINIO_ROOT=minioadmin` |

## CONTROL PLANE notes

- Catalog postgres retained Manager library after finalize.
- Happy path download: `mode=presign` → object host GET.
- No requirement that API streamed the 3.5MB body for Manager happy path.

## ROLLBACK

After evidence:

```text
RECORDING_STORAGE=local
EGRESS_OUTPUT=local
```

Health after rollback:

```json
{"status":"ok","recordingCatalog":"postgres","recordingStorage":"local","egressOutput":"local","s3PublicConfigured":true,"supportsPresignedGet":false}
```

Containers up; default path local again. MinIO may remain running under profile but unused by backend defaults.

## Language

- **Direct S3 implementation:** completed (code + lab scaffolding).  
- **Production-shaped E2E proof:** **captured in this file** for one real recording on VPS lab.
