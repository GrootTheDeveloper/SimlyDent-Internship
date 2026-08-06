#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
LOG=/root/livekit-deploy2.log
exec > >(tee -a "$LOG") 2>&1
echo "===== DEPLOY2 START $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 7881/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 50000:50050/udp
ufw --force enable
ufw status || true

mkdir -p /opt
cd /opt
if [ ! -d SimlyDent-Internship/.git ]; then
  git clone https://github.com/GrootTheDeveloper/SimlyDent-Internship.git
else
  (cd SimlyDent-Internship && git pull --ff-only) || true
fi

APP=/opt/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1
cd "$APP"
ls -la scripts/start-vps.sh docker-compose.vps.yml

SECRET=$(openssl rand -base64 36 | tr -d '\n')
cat > .env <<EOF
DOMAIN=103.28.32.118.sslip.io
TURN_DOMAIN=103.28.32.118.sslip.io
PUBLIC_IP=103.28.32.118
ACME_EMAIL=admin@103.28.32.118.sslip.io
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=${SECRET}
EOF
grep -E '^(DOMAIN|TURN_DOMAIN|PUBLIC_IP|LIVEKIT_API_KEY)=' .env
echo "LIVEKIT_API_SECRET=hidden"

chmod +x scripts/start-vps.sh
./scripts/start-vps.sh

echo "===== COMPOSE PS ====="
docker compose -f docker-compose.vps.yml ps
echo "===== GATEWAY LOGS ====="
docker compose -f docker-compose.vps.yml logs --tail=50 gateway || true
echo "===== LIVEKIT LOGS ====="
docker compose -f docker-compose.vps.yml logs --tail=30 livekit || true
echo "===== DEPLOY2 DONE $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
