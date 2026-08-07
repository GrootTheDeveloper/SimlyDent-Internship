# R-presign

## Endpoint

`GET /api/calls/{callId}/recording/download-url` (Manager JWT)

- Authority: **PostgreSQL catalog** (Ready + clinic match), not in-memory CallSession  
- Response: `{ url, expiresAt, mode: "presign"|"proxy", recordingId, callId }`  
- Audit: **`RecordingDownloadUrlIssued`** only (does not prove download)

## Modes

| mode | When | Client |
|------|------|--------|
| `proxy` | Local storage / no public S3 endpoint | `GET url` with Bearer → `.../recording/file` streams bytes; audit **RecordingDownloaded** |
| `presign` | S3 + `S3_PUBLIC_ENDPOINT` set | Browser opens signed URL (no Bearer); storage access logs for real GET later |

## Env

| Variable | Role |
|----------|------|
| `S3_INTERNAL_ENDPOINT` | API Head/Put/Delete (may be `http://minio:9000`) |
| `S3_PUBLIC_ENDPOINT` | Presign host + Egress Direct S3 upload (browser-reachable; HTTPS for production-shaped lab) |
| `RECORDING_PRESIGN_TTL_SECONDS` | Default 300, max 900 |

Never log full signed URL query strings.
