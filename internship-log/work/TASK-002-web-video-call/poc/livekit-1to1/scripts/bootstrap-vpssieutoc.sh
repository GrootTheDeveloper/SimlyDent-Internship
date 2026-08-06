#!/usr/bin/env bash
# One-shot bootstrap for VPS Siêu Tốc (Ubuntu) — LiveKit 1:1 PoC
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
LOG=/root/livekit-bootstrap.log
exec > >(tee -a "$LOG") 2>&1
echo "===== BOOTSTRAP START $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="

# Swap 2G
if ! swapon --show 2>/dev/null | grep -q .; then
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
free -h

apt-get update -y
apt-get install -y ca-certificates curl gnupg git ufw openssl

if ! command -v docker >/dev/null 2>&1; then
  # get.docker.com may fail on Ubuntu 18.04 (docker-model-plugin missing)
  curl -fsSL https://get.docker.com | sh || true
fi
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin \
    || apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable docker
systemctl start docker
docker --version
docker compose version || docker-compose version || true

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
test -f scripts/start-vps.sh

SECRET=$(openssl rand -base64 36 | tr -d '\n')
cat > .env <<EOF
DOMAIN=103.28.32.118.sslip.io
TURN_DOMAIN=103.28.32.118.sslip.io
PUBLIC_IP=103.28.32.118
ACME_EMAIL=admin@103.28.32.118.sslip.io
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=${SECRET}
EOF
echo "Wrote .env"
grep -E '^(DOMAIN|TURN_DOMAIN|PUBLIC_IP|ACME_EMAIL|LIVEKIT_API_KEY)=' .env
echo "LIVEKIT_API_SECRET=***hidden***"

chmod +x scripts/start-vps.sh
./scripts/start-vps.sh

echo "===== COMPOSE PS ====="
if docker compose version >/dev/null 2>&1; then
  docker compose -f docker-compose.vps.yml ps
  docker compose -f docker-compose.vps.yml logs --tail=50 gateway || true
else
  docker-compose -f docker-compose.vps.yml ps
  docker-compose -f docker-compose.vps.yml logs --tail=50 gateway || true
fi

echo "===== BOOTSTRAP DONE $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
