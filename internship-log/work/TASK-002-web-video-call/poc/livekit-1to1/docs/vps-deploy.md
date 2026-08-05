# Deploy LiveKit PoC lên VPS (máy khác mạng vào được)

Mục tiêu: một server public, hai client ở **mạng khác nhau** mở `https://DOMAIN` và gọi video 1:1.

## Vì sao cần VPS (không chỉ tunnel / LAN)

| Cách | UI HTTPS | Media WebRTC khác mạng |
|---|---|---|
| LAN / Mobile Hotspot | Có | Chỉ cùng mạng |
| Cloudflare Quick Tunnel | Có (demo) | **Không** đủ — media vẫn trỏ LAN |
| **VPS + domain + UDP + TURN** | Có | **Được** (đúng hướng production) |

WebRTC cần:

1. **HTTPS** (secure context) để browser cho camera/mic  
2. **IP public** trong ICE candidate (LiveKit `--node-ip` / `use_external_ip`)  
3. **UDP media ports** mở trên firewall  
4. **TURN** khi NAT/firewall chặn P2P hoặc path thẳng tới VPS  

## Yêu cầu VPS

- Ubuntu 22.04/24.04 (hoặc distro tương đương) **khuyến nghị**
- Docker Engine + Compose plugin  
- Public IPv4  
- Domain (hoặc subdomain) trỏ **A record** → IP VPS  
- RAM ≥ 2 GB (ghi hình Egress: ≥ 4 GB)  
- Mở port (cloud security group + `ufw` nếu có):

| Port | Protocol | Mục đích |
|---:|---|---|
| 80 | TCP | ACME + redirect |
| 443 | TCP | UI, API, SignalR, LiveKit signaling |
| 7881 | TCP | WebRTC TCP fallback |
| 3478 | TCP+UDP | TURN |
| 50000–50050 | UDP | WebRTC media (LiveKit SFU) |

## 1. DNS

```text
A    call.example.com    ->  YOUR_VPS_PUBLIC_IP
```

Chờ resolve:

```bash
dig +short call.example.com
```

## 2. Cài Docker (Ubuntu)

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# logout/login, rồi:
docker compose version
```

## 3. Clone và cấu hình

```bash
git clone https://github.com/GrootTheDeveloper/SimlyDent-Internship.git
cd SimlyDent-Internship/internship-log/work/TASK-002-web-video-call/poc/livekit-1to1

cp .env.vps.example .env
nano .env
```

Điền tối thiểu:

```env
DOMAIN=call.example.com
TURN_DOMAIN=call.example.com
PUBLIC_IP=x.x.x.x
ACME_EMAIL=ban@email.com
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=<chuỗi ngẫu nhiên dài>
```

Tạo secret:

```bash
openssl rand -base64 36
```

## 4. Firewall

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7881/tcp
sudo ufw allow 3478
sudo ufw allow 50000:50050/udp
sudo ufw enable
```

Provider (AWS / GCP / Azure / Contabo / …): mở **cùng** rule trên security group / firewall panel.

## 5. Chạy stack

```bash
chmod +x scripts/start-vps.sh
./scripts/start-vps.sh
```

Có recording (nặng hơn):

```bash
RECORDING=1 ./scripts/start-vps.sh
```

## 6. Kiểm tra

```bash
# HTTPS + API
curl -sS "https://$DOMAIN/api/identities" | head

# Containers
docker compose -f docker-compose.vps.yml ps
docker compose -f docker-compose.vps.yml logs -f gateway livekit backend
```

Trình duyệt (hai máy / hai mạng):

1. `https://DOMAIN/?user=A1`
2. `https://DOMAIN/?user=A2`
3. A1 gọi A2 → chấp nhận → cấp camera/mic  

## 7. Checklist khi “vào được UI nhưng không có hình/tiếng”

1. `PUBLIC_IP` đúng IP public của VPS (không dùng IP Docker `172.x`).  
2. UDP `50000–50050` đã mở (thường hay quên trên cloud).  
3. TURN `3478` (TCP+UDP) đã mở.  
4. DNS đã trỏ đúng; cert Caddy không lỗi (`docker compose logs gateway`).  
5. Client không bị corporate firewall chặn UDP (khi đó TURN/TLS 443-path quan trọng hơn — có thể tinh chỉnh sau).  
6. LiveKit log có hai participant `active` và không ICE timeout.

## 8. Bảo mật PoC (chưa production)

- Auth vẫn là header `X-User-Id` (demo). **Không** để internet mở lâu mà không reverse proxy auth / VPN / IP allowlist nếu có data nhạy cảm.  
- Đổi `LIVEKIT_API_SECRET` mạnh; không commit `.env`.  
- Recording chỉ bật khi cần (`--profile recording`).  
- Production: auth JWT thật, HTTPS HSTS, rate limit, PostgreSQL, TURN secret rotate, backup.

## 9. Lệnh dừng / cập nhật

```bash
docker compose -f docker-compose.vps.yml pull
docker compose -f docker-compose.vps.yml up -d --build

docker compose -f docker-compose.vps.yml down
```

## 10. File liên quan

| File | Vai trò |
|---|---|
| `docker-compose.vps.yml` | Stack VPS |
| `infra/livekit.vps.yaml` | Template SFU + TURN + external IP |
| `infra/livekit.vps.runtime.yaml` | File chạy (sinh bởi script, không commit) |
| `infra/Caddyfile.vps` | HTTPS Let's Encrypt |
| `.env.vps.example` | Mẫu biến môi trường |
| `scripts/start-vps.sh` | Deploy Linux |
| `scripts/start-vps.ps1` | Deploy Windows Server (ít dùng) |

Local LAN PoC vẫn dùng `scripts/start.ps1` + `docker-compose.yml` như cũ.

## 11. Tối thiểu bạn cần chuẩn bị

1. **VPS** có IPv4 public + Docker  
2. **Domain** trỏ A → IP VPS  
3. Mở port **80, 443, 7881, 3478, 50000–50050/udp**  
4. Điền `.env` rồi `./scripts/start-vps.sh`  
5. Hai máy (khác Wi‑Fi/4G) mở `https://DOMAIN/?user=A1` và `A2`

## 12. CI/CD GitHub Actions (push → VPS)

Workflow: [`.github/workflows/deploy-livekit-vps.yml`](../../../../.github/workflows/deploy-livekit-vps.yml)

Khi push `main` và có thay đổi trong `poc/livekit-1to1/**` (hoặc bấm **Run workflow**), Actions SSH vào VPS → `git reset --hard origin/main` → `./scripts/start-vps.sh` → smoke API.

### Secrets (GitHub repo → Settings → Secrets and variables → Actions)

| Name | Ví dụ | Ghi chú |
|------|--------|---------|
| `VPS_HOST` | `103.28.32.118` | |
| `VPS_USER` | `root` | |
| `VPS_SSH_KEY_B64` | *(một dòng base64)* | **Khuyến nghị** — tránh lỗi `ssh: no key found` khi paste key multiline |
| `VPS_SSH_KEY` | private key raw | Tuỳ chọn nếu không dùng B64 |

Lấy base64 trên Windows:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.ssh\simlydent_vps_deploy"))
```

Hoặc:

```powershell
.\scripts\setup-github-deploy-secrets.ps1   # cần gh auth login
```

### Tạo deploy key (một lần)

Trên máy dev (PowerShell):

```powershell
ssh-keygen -t ed25519 -f $env:USERPROFILE\.ssh\simlydent_vps_deploy -C "github-actions-livekit" -N '""'
Get-Content $env:USERPROFILE\.ssh\simlydent_vps_deploy.pub
```

Trên VPS (SSH root):

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'PASTE_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**Không** dán file `.pub` vào secret. Secret là **private** key (hoặc base64 của private key).

### Lưu ý

- File `.env` trên VPS **không** nằm trong git — CI không ghi đè secret.  
- `infra/livekit.vps.runtime.yaml` được sinh lại mỗi lần deploy.  
- Path cố định: `/opt/SimlyDent-Internship/.../livekit-1to1`  
- Repo GitHub cần **public** (hoặc VPS có credential `git pull`); hiện clone HTTPS public.
