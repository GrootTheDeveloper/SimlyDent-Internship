# Direct S3 lab (Phase C) — hard rules

**Default VPS stays local.** Lab is opt-in.

## Hard rules

1. Direct Egress S3 → **HTTPS** only.  
2. **`S3_PUBLIC_ENDPOINT=https://s3.{DOMAIN}`** dedicated host — **never** `https://{DOMAIN}/s3` path prefix (SigV4 signs `/{bucket}/{key}`).  
3. Caddy `s3.DOMAIN { reverse_proxy minio:9000 }` — **preserve Host + URI** (no `header_up Host`).  
4. **Primary evidence = real LiveKit recording**, not plant.  
5. **Non-root** bucket-scoped lab user (`scripts/minio-lab-bootstrap.sh`).  
6. Fail-fast by capability (`RecordingS3Config`):  
   - `EGRESS_OUTPUT=s3` → HTTPS public + bucket + write keys  
   - `RECORDING_STORAGE=s3` → internal endpoint + bucket + keys  
   - `REQUIRE_PRESIGNED_DOWNLOAD=1` → HTTPS public  
7. Evidence proves **both** write and read byte paths bypass ASP.NET.  
8. Rollback to local after test.

## Enable lab on VPS

```bash
# .env additions (example DOMAIN=103.28.32.118.sslip.io)
S3_DOMAIN=s3.103.28.32.118.sslip.io
S3_PUBLIC_ENDPOINT=https://s3.103.28.32.118.sslip.io
S3_INTERNAL_ENDPOINT=http://minio:9000
S3_BUCKET=simlydent-recordings
S3_PATH_STYLE=1
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=...          # root, private
S3_ACCESS_KEY=simlydent-lab      # non-root after bootstrap
S3_SECRET_KEY=...
RECORDING_STORAGE=s3
EGRESS_OUTPUT=s3
REQUIRE_PRESIGNED_DOWNLOAD=1

# Deploy
MINIO_LAB=1 RECORDING=1 ./scripts/start-vps.sh
chmod +x scripts/minio-lab-bootstrap.sh
./scripts/minio-lab-bootstrap.sh
# put S3_ACCESS_KEY/SECRET into .env, recreate backend
docker compose -f docker-compose.vps.yml --profile minio --profile recording up -d --force-recreate backend gateway egress
```

## Rollback

```bash
RECORDING_STORAGE=local
EGRESS_OUTPUT=local
# unset S3_PUBLIC_ENDPOINT REQUIRE_PRESIGNED_DOWNLOAD
# optional: stop minio profile
```

## E2E

1. Real call: A1/A2, Video, start/stop recording.  
2. Wait Ready (webhook/reconcile).  
3. A-MGR download → Network: `download-url` JSON + `https://s3.DOMAIN/...` media.  
4. Fill `evidence/phase-c-s3-lab/EVIDENCE.template.md` (from `scripts/recording-s3-e2e.ps1`).

## Architecture (lab)

```text
Egress  ──HTTPS──► https://s3.DOMAIN ──Caddy──► minio:9000
Browser ──presign──► same host
API     ──HTTP──► http://minio:9000  (Head/Delete only on happy path)
```
