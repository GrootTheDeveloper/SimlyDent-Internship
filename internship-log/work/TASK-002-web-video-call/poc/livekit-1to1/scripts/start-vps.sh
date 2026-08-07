#!/usr/bin/env bash
# Deploy LiveKit 1:1 PoC on a public VPS so clients on any network can join.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  if [[ -f .env.vps.example ]]; then
    cp .env.vps.example .env
    echo "Created .env from .env.vps.example — edit DOMAIN, PUBLIC_IP, LIVEKIT_API_SECRET then re-run."
    exit 1
  fi
  echo "Missing .env — create one from .env.vps.example"
  exit 1
fi

# shellcheck disable=SC1091
set -a
source .env
set +a

: "${DOMAIN:?DOMAIN is required}"
: "${PUBLIC_IP:?PUBLIC_IP is required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET is required}"

# LiveKit yaml uses ${TURN_DOMAIN}; export for compose variable substitution
export TURN_DOMAIN="${TURN_DOMAIN:-$DOMAIN}"
export ACME_EMAIL="${ACME_EMAIL:-admin@${DOMAIN}}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required. Install Docker Engine + Compose plugin on the VPS."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose not found."
  exit 1
fi

echo "Deploying for DOMAIN=$DOMAIN PUBLIC_IP=$PUBLIC_IP"

# Materialize LiveKit config (TURN domain cannot use Docker env substitution).
TEMPLATE="$ROOT/infra/livekit.vps.yaml"
RUNTIME="$ROOT/infra/livekit.vps.runtime.yaml"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "Missing $TEMPLATE"
  exit 1
fi
sed "s/TURN_DOMAIN_PLACEHOLDER/${TURN_DOMAIN//\//\\/}/g" "$TEMPLATE" > "$RUNTIME"
echo "Wrote $RUNTIME (TURN domain: $TURN_DOMAIN)"

# Materialize Caddyfile: optional s3.DOMAIN site (Host+URI preserved for SigV4).
CADDY_TEMPLATE="$ROOT/infra/Caddyfile.vps"
CADDY_RUNTIME="$ROOT/infra/Caddyfile.vps.runtime"
cp "$CADDY_TEMPLATE" "$CADDY_RUNTIME"
if [[ -n "${S3_DOMAIN:-}" ]]; then
  cat >> "$CADDY_RUNTIME" <<EOF

# Phase C Direct S3 — dedicated hostname; do NOT rewrite Host or path.
${S3_DOMAIN} {
	reverse_proxy minio:9000
}
EOF
  echo "Appended S3 site to Caddyfile.vps.runtime (S3_DOMAIN=$S3_DOMAIN)"
  export S3_DOMAIN
else
  echo "S3_DOMAIN unset — no public MinIO site (local recording default)."
fi
# Compose gateway mounts runtime if present; fall back handled in compose via single file — use runtime always.
export CADDYFILE_RUNTIME=1

# Optional recording stack: RECORDING=1 ./scripts/start-vps.sh
# Optional MinIO lab: MINIO_LAB=1 ./scripts/start-vps.sh
PROFILES=()
if [[ "${RECORDING:-0}" == "1" ]]; then
  PROFILES+=(--profile recording)
  # Egress container runs as uid 1001; host bind-mount is often root-owned.
  mkdir -p "$ROOT/recordings"
  chmod 777 "$ROOT/recordings" || true
fi
if [[ "${MINIO_LAB:-0}" == "1" ]]; then
  PROFILES+=(--profile minio)
fi

"${COMPOSE[@]}" -f docker-compose.vps.yml "${PROFILES[@]}" up -d --build

echo
echo "Waiting for gateway..."
sleep 3
"${COMPOSE[@]}" -f docker-compose.vps.yml ps

echo
echo "Public URL:  https://${DOMAIN}/?user=A1"
echo "Second user: https://${DOMAIN}/?user=A2"
echo
echo "Open on the VPS firewall / cloud security group:"
echo "  80/tcp 443/tcp 7881/tcp 3478/tcp+udp 50000-50050/udp"
echo
echo "Smoke API (from any machine that can reach the VPS):"
echo "  curl -sS https://${DOMAIN}/api/identities"
echo
echo "DNS must point A ${DOMAIN} -> ${PUBLIC_IP} before Let's Encrypt can issue certs."
