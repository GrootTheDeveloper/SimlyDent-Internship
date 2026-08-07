#!/usr/bin/env bash
# Create private bucket + non-root lab service account for Phase C Direct S3.
# Run on VPS after: MINIO_LAB=1 docker compose ... up -d minio
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MINIO_ROOT_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:-minioadmin}"
S3_BUCKET="${S3_BUCKET:-simlydent-recordings}"
# Lab app credentials (NOT root)
S3_ACCESS_KEY="${S3_ACCESS_KEY:-simlydent-lab}"
S3_SECRET_KEY="${S3_SECRET_KEY:-simlydent-lab-secret-change-me}"

echo "Bootstrapping MinIO bucket=$S3_BUCKET user=$S3_ACCESS_KEY (non-root)"

docker run --rm --network livekit-1to1_default \
  -e MINIO_ROOT_USER -e MINIO_ROOT_PASSWORD -e S3_BUCKET -e S3_ACCESS_KEY -e S3_SECRET_KEY \
  minio/mc:RELEASE.2025-04-16T18-13-26Z \
  /bin/sh -c '
    set -e
    mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
    mc mb -p "local/$S3_BUCKET" || true
    mc anonymous set none "local/$S3_BUCKET"
    # Service account with full bucket access for lab (split roles = Phase D)
    mc admin user add local "$S3_ACCESS_KEY" "$S3_SECRET_KEY" || true
    cat > /tmp/policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:*"],
      "Resource": ["arn:aws:s3:::$S3_BUCKET", "arn:aws:s3:::$S3_BUCKET/*"]
    }
  ]
}
EOF
    mc admin policy create local simlydent-lab-bucket /tmp/policy.json || mc admin policy add local simlydent-lab-bucket /tmp/policy.json || true
    mc admin policy attach local simlydent-lab-bucket --user "$S3_ACCESS_KEY" || true
    echo "OK: bucket private, user $S3_ACCESS_KEY attached"
  '

echo
echo "Put into .env for lab (do not use minioadmin as S3_ACCESS_KEY):"
echo "  S3_ACCESS_KEY=$S3_ACCESS_KEY"
echo "  S3_SECRET_KEY=$S3_SECRET_KEY"
echo "  S3_BUCKET=$S3_BUCKET"
echo "  MINIO_ROOT_USER=$MINIO_ROOT_USER   # root stays private"
echo "  MINIO_ROOT_PASSWORD=***"
