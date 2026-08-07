# Direct S3 lab (Phase C)

**Default VPS stays local.** Enable only for lab proof.

## Production-shaped path

```text
Egress ──HTTPS S3 (S3_PUBLIC_ENDPOINT)──► MinIO/object bucket
webhook/reconcile + HeadObject ──► Ready
Manager ──presign (same public host)──► browser GET
Retention ──DeleteObject──► Deleted
```

## Requirements

1. MinIO (or compatible) running on compose network  
2. Expose MinIO via **HTTPS** on a browser-reachable host (Caddy path/subdomain on `DOMAIN`) — **not** only `http://minio:9000` for Egress  
3. Env example:

```bash
RECORDING_STORAGE=s3
EGRESS_OUTPUT=s3
S3_INTERNAL_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://YOUR_DOMAIN/s3   # or https://minio.YOUR_DOMAIN
S3_BUCKET=simlydent-recordings
S3_PATH_STYLE=1
S3_ACCESS_KEY=...
S3_SECRET_KEY=...
```

4. Create bucket before first record  
5. Egress container must resolve `S3_PUBLIC_ENDPOINT`  
6. Force path style for MinIO  

## Rollback

```bash
RECORDING_STORAGE=local
EGRESS_OUTPUT=local
# unset S3_PUBLIC_ENDPOINT
```

## Acceptance checklist

- [ ] Record + stop → Finalizing fast → Ready  
- [ ] Object visible in bucket  
- [ ] download-url mode=presign  
- [ ] Browser GET hits storage host, not Kestrel body for media  
- [ ] Cross-clinic 404  
- [ ] Retention deletes object when due  

MinIO is an **integration fixture**; production vendor (SeaweedFS/Ceph/…) is a later ops decision.
