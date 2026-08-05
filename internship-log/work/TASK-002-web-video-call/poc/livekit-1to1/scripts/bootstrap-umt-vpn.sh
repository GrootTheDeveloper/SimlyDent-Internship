#!/usr/bin/env bash
# Bootstrap LiveKit 1:1 PoC on UMT private VPS (VPN-only access).
# Safe to re-run. Requires: Ubuntu 22.04+, sudo, network to Docker Hub + GitHub.
set -euo pipefail

VPN_IP="${VPN_IP:-10.11.10.23}"
REPO_URL="${REPO_URL:-https://github.com/GrootTheDeveloper/SimlyDent-Internship.git}"
APP_DIR="${APP_DIR:-$HOME/SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1}"

echo "==> Target VPN IP: $VPN_IP"
echo "==> App dir: $APP_DIR"

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run as normal user with sudo (not as root)."
  exit 1
fi

echo "==> Install base packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git openssl

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Install Docker"
  curl -fsSL https://get.docker.com | sudo sh
else
  echo "==> Docker already installed: $(docker --version)"
fi

if ! groups | grep -q '\bdocker\b'; then
  echo "==> Add $USER to docker group"
  sudo usermod -aG docker "$USER"
fi

# Prefer rootless-free docker via sg when group not active in this shell
docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  elif command -v sg >/dev/null 2>&1; then
    sg docker -c "docker $*"
  else
    sudo docker "$@"
  fi
}

compose_cmd() {
  if docker compose version >/dev/null 2>&1; then
    docker_cmd compose "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      docker-compose "$@"
    else
      sudo docker-compose "$@"
    fi
  else
    echo "docker compose not found"
    exit 1
  fi
}

echo "==> Clone / update repo"
if [[ -d "$HOME/SimlyDent-Internship/.git" ]]; then
  git -C "$HOME/SimlyDent-Internship" pull --ff-only || true
else
  git clone "$REPO_URL" "$HOME/SimlyDent-Internship"
fi

cd "$APP_DIR"

if [[ ! -f .env ]]; then
  echo "==> Create .env"
  SECRET="$(openssl rand -base64 36)"
  cat > .env <<EOF
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=${SECRET}
LAN_IP=${VPN_IP}
EOF
else
  echo "==> .env exists — ensure LAN_IP=${VPN_IP}"
  if grep -q '^LAN_IP=' .env; then
    sed -i "s/^LAN_IP=.*/LAN_IP=${VPN_IP}/" .env
  else
    echo "LAN_IP=${VPN_IP}" >> .env
  fi
fi

echo "==> Firewall (ufw if present)"
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow OpenSSH || true
  sudo ufw allow 5173/tcp || true
  sudo ufw allow 5080/tcp || true
  sudo ufw allow 8443/tcp || true
  sudo ufw allow 8088/tcp || true
  sudo ufw allow 7880/tcp || true
  sudo ufw allow 7881/tcp || true
  sudo ufw allow 50000:50020/udp || true
  # Do not force-enable ufw if admin left it off
  sudo ufw status || true
fi

echo "==> docker compose up (build can take several minutes)"
# Use sg docker when needed so we do not require re-login mid-script
if docker info >/dev/null 2>&1; then
  docker compose -f docker-compose.yml up -d --build
elif command -v sg >/dev/null 2>&1 && groups | grep -q docker || getent group docker | grep -q "\b${USER}\b"; then
  sg docker -c "cd '$APP_DIR' && docker compose -f docker-compose.yml up -d --build"
else
  sudo docker compose -f docker-compose.yml up -d --build
fi

echo "==> Wait for health"
sleep 5
set +e
curl -fsS "http://127.0.0.1:5080/health" && echo || echo "health check pending..."
if docker info >/dev/null 2>&1; then
  docker compose ps
else
  sg docker -c "cd '$APP_DIR' && docker compose ps" 2>/dev/null || sudo docker compose ps
fi
set -e

cat <<EOF

============================================================
DEPLOY DONE (UMT VPN)

From a Windows client (VPN ON):
  1) Download CA:   http://${VPN_IP}:8088/root.crt
     Install into Trusted Root Certification Authorities
     Restart browser
  2) Caller:  https://${VPN_IP}:8443/?user=A1
  3) Callee:  https://${VPN_IP}:8443/?user=A2

API health: http://${VPN_IP}:5080/health
UI plain:   http://${VPN_IP}:5173  (camera may fail without HTTPS)

Logs:
  cd ${APP_DIR}
  docker compose logs -f gateway backend livekit
============================================================
EOF
