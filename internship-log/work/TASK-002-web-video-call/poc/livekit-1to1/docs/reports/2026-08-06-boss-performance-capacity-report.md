# Báo cáo PoC Video Call 1:1 (LiveKit) — Hạ tầng, đo lường & kết luận tạm thời

| | |
|---|---|
| **Trạng thái tài liệu** | **DRAFT** — capacity ceiling **đã chốt** (soft max N=30); call browser 3–4 lần **chưa** hoàn tất |
| **Ngày soạn** | 2026-08-06 |
| **Phiên bản hệ thống** | Git `563f23e` (VPS deploy) |
| **Môi trường chính** | VPS production-demo `103.28.32.118` |
| **URL** | https://103.28.32.118.sslip.io/ |
| **Mục đích** | Tổng hợp cho lãnh đạo: cấu hình, yếu tố ảnh hưởng, chỉ số đã đo, giới hạn, bước tiếp |

> **Lưu ý đọc nhanh:** Số capacity dưới đây chủ yếu từ **media giả (CLI)** trên VPS, **không** thay thế nghiệm thu **2 máy cam thật**. Kết luận “chịu được X cuộc gọi HD cho end-user” cần bổ sung sau khi xong PERF browser × 3–4 lần.

---

## 1. Tóm tắt điều hành (Executive summary)

### 1.1 Đã làm được

1. **PoC video 1:1** self-host (LiveKit SFU + ASP.NET API + Vue UI), deploy **VPS public**, HTTPS (sslip.io), TURN cho client khác mạng.  
2. **Auth JWT** (login `Demo@123`), tenant isolation, presence online/offline (SignalR).  
3. **Tự đo chất lượng call thật** trong browser (bitrate, loss, RTT…) → export CSV/JSON.  
4. **Đo chịu tải server** bằng ladder concurrent rooms (CLI) + API concurrent pairs.  
5. **CD** GitHub Actions → SSH VPS khi push `main`.

### 1.2 Kết luận tạm (có điều kiện)

| Chủ đề | Kết luận tạm | Độ tin cậy |
|---|---|---|
| API / signaling | **≥ 8 cặp call** create–accept–token–end đồng thời **100%** trên VPS | Cao (đã đo) |
| SFU media (CLI giả) | **30/30 room OK** (ladder max); CPU mid cao nhất quan sát ~**73%** @ 25 room — **chưa** fail process / chưa chạm CPU ~180% | Cao |
| Tổng bitrate media | Bão hòa khoảng **~50–65 Mbps** từ ~8–10 room trở đi (peak đo ~**64 Mbps** @ N=30) | Cao (Prometheus) |
| Call cam 2 máy | UI + auto telemetry sẵn; **chưa** có bộ 3–4 run × 5 phút đủ thống kê | Thấp (chưa xong) |
| Recording production | Có PoC Egress; **chưa** consent/retention/S3 | N/A (out of scope đo lần này) |

### 1.3 Rủi ro / hạn chế PoC (cần nói rõ với sếp)

- Backend **in-memory**: restart = mất call state.  
- Media join token **60 phút** (đã nâng từ 5 phút); chưa refresh token giữa call.  
- Domain **sslip.io** demo, không phải domain công ty.  
- Ubuntu **18.04**, kernel cũ — chấp nhận cho lab, cân nhắc nâng OS production.  
- Load CLI **≠** chất lượng cảm nhận HD trên 4G/office Wi‑Fi.  
- Ceiling ladder đã chạy hết **N=1…30**: **soft ceiling** (hết ladder, không process fail). Muốn “vỡ cứng” cần N cao hơn hoặc topology nặng hơn / recording.

---

## 2. Phạm vi & phương pháp

### 2.1 Trong phạm vi báo cáo

- Hạ tầng VPS + stack container.  
- Yếu tố ảnh hưởng chất lượng / capacity.  
- Chỉ số API load, media load (CLI + Prometheus + docker stats).  
- Cơ chế đo call thật (đã implement).  
- Kết luận tạm + khuyến nghị.

### 2.2 Ngoài phạm vi / chưa xong

| Hạng mục | Trạng thái |
|---|---|
| PERF browser 5–15 phút × **3–4 lần** (bitrate/RTT p50) | **Chưa hoàn tất** |
| Ceiling media N=30 / điểm fail cứng | **Xong soft max N=30** (0 fail); fail cứng **chưa** đạt |
| So sánh multi-network (2 ISP) có bảng số | **Chưa** (hạ tầng TURN đã có) |
| Recording load + disk | **Chưa** trong ladder capacity |
| TCO / chi phí / SLA production | **Không** đặt số bịa |

### 2.3 Hai lớp đo (không trộn)

| Lớp | Công cụ | Ý nghĩa |
|---|---|---|
| **A. Call thật** | 2 máy browser, cam/mic | UX + WebRTC getStats → CSV |
| **B. Capacity SFU** | `lk load-test` trên VPS | Bao nhiêu room media giả / CPU / Mbps |

---

## 3. Hạ tầng & cấu hình (mọi thứ ảnh hưởng)

### 3.1 Máy chủ (VPS)

| Hạng mục | Giá trị quan sát |
|---|---|
| Nhà cung cấp / hostname | VPS Siêu Tốc (`vpssieutoc…`), plan kiểu **GOLD 4** (lab) |
| Public IP | **103.28.32.118** |
| Domain demo | **103.28.32.118.sslip.io** (HTTPS Let’s Encrypt qua Caddy) |
| OS | **Ubuntu 18.04 LTS** |
| Kernel | 4.15.0-22-generic (x86_64) |
| CPU | **2 vCPU** (`nproc=2`) |
| RAM | **~3.9 GiB** (+ Swap 2 GiB) |
| Disk | ~50 GB class (theo plan; không benchmark I/O lần này) |

**Ảnh hưởng:** 2 core + 4 GB là **trần cứng** cho concurrent HD + CLI publishers; không kỳ vọng hàng chục call HD simultaneous như cloud lớn.

### 3.2 Stack phần mềm (Docker Compose VPS)

| Thành phần | Image / tech | Vai trò |
|---|---|---|
| LiveKit Server | **v1.13.1** | SFU WebRTC, TURN nhúng |
| Redis | 7.4-alpine | Phối hợp LiveKit (+ Egress khi bật) |
| Backend | ASP.NET Core (self-build) | Call state, JWT, SignalR, quality API |
| Frontend | Vue 2.7 + livekit-client, nginx | UI login / call / quality panel |
| Gateway | Caddy 2.11 | TLS, reverse proxy |
| Egress | v1.12.0 (profile recording) | Ghi MP4 (không bật trong capacity ladder) |
| LiveKit CLI | v2.12.2 (cài trên host lúc test) | load-test media giả |

**Deploy path:** `/opt/SimlyDent-Internship/.../poc/livekit-1to1`  
**CI/CD:** GitHub Actions `Deploy LiveKit VPS` (push `main`).

### 3.3 Mạng & cổng

| Cổng / range | Protocol | Mục đích |
|---|---|---|
| 80, 443 | TCP | HTTPS UI + API + signaling (qua Caddy) |
| 7881 | TCP | WebRTC TCP fallback |
| 3478 | TCP+UDP | TURN |
| 50000–50050 | UDP | Media WebRTC (~51 port) |
| 6789 | (nội bộ container) | Prometheus metrics LiveKit |

**STUN:** Google public STUN trong config LiveKit.  
**TURN:** bật trên VPS (domain/sslip) — quan trọng khi client NAT/firewall.  
**PUBLIC_IP:** 103.28.32.118 gắn node LiveKit.

**Ảnh hưởng:**

- Range UDP **hẹp (51 port)** → giới hạn concurrent ICE ở mức cao.  
- Client **corporate Wi‑Fi / 4G** có thể buộc **TURN** → tốn băng thông/CPU VPS hơn path host.  
- Latency / packet loss **phụ thuộc mạng client**, không chỉ VPS.

### 3.4 Cấu hình media / app (ảnh hưởng chất lượng)

| Tham số | Giá trị PoC | Ảnh hưởng |
|---|---|---|
| Mục tiêu publish | ~720p / 30 fps, max ~2.5 Mbps, VP8, simulcast | HD khi mạng/CPU đủ |
| Adaptive / dynacast | Bật | Tự giảm layer khi tải cao |
| LiveKit join token TTL | **60 phút** | Call dài hơn 5’ (trước đây 5’ cắt media) |
| App JWT | ~480 phút | Session SPA |
| Busy rule | 1 user 1 call active | Không 2 call cam cùng A1 |
| Call state | **RAM process** | Mất khi restart backend |
| Quality sample | Mỗi 2s client, flush ~10s | File CSV sau call |
| Recording | Egress MP4 local volume | Nặng CPU; chưa trong load ladder |

### 3.5 Client / thiết bị (ảnh hưởng call thật)

| Yếu tố | Ghi chú |
|---|---|
| Browser | Chrome/Edge desktop; Safari iOS hành vi khác (autoplay, HEVC…) |
| Camera/mic permission | User phải Allow |
| CPU laptop/phone | Encode phía client |
| Mạng client | Wi‑Fi isolation, 4G, VPN, firewall UDP |
| Số máy lab | **2 máy** → 1 call cam; capacity dùng CLI |

---

## 4. Kịch bản test đã / đang chạy

### 4.1 API concurrent (VPS, 2026-08-06)

- User synthetic `L01`… (JWT `Demo@123`).  
- Mỗi pair: login → create → accept → token → hold 3s → end.  
- Ladder: **1, 3, 5, 8** pairs.

### 4.2 Media SFU short ladder (VPS)

- `lk load-test`, mỗi room: **2 video publishers + 2 subscribers**, high resolution, ~25s.  
- N = **1, 3, 5**.  
- Docker stats; Prometheus lúc đó **chưa** bật trên process cũ → Mbps lần 1 = 0.

### 4.3 Media ceiling ramp (VPS, **hoàn tất**)

- Cùng topology, **30s/level**.  
- N = 1 → 3 → 5 → 8 → 10 → 12 → 15 → 18 → 20 → 25 → **30** (hết ladder).  
- Prometheus bật.  
- Stop rule: process fail **hoặc** CPU mid ≥ ~180% **hoặc** hết ladder → **dừng vì hết ladder** (soft end).

### 4.4 Call browser thật

- URL VPS, A1/A2.  
- Auto WebRTC stats + export CSV.  
- Protocol: 3–4 × ~5 phút — **chưa đủ data cho bảng p50 trong report này**.

---

## 5. Chỉ số đã đo được

### 5.1 API / signaling (VPS)

| Concurrent pairs | Success | Wall time (ms) |
|---:|---:|---:|
| 1 | 1/1 (100%) | ~3998 |
| 3 | 3/3 (100%) | ~4437 |
| 5 | 5/5 (100%) | ~5273 |
| 8 | 8/8 (100%) | ~6535 |

**Diễn giải:** Backend + JWT + state machine **không** là bottleneck so với media. Wall tăng nhẹ do parallel login/HTTP.

### 5.2 Media capacity — short ladder (CPU only, 25s)

| Rooms | Process OK | LiveKit CPU (sample) | LiveKit RAM |
|---:|---:|---:|---|
| 1 | 1/1 | ~22% | ~74 MB |
| 3 | 3/3 | ~25% | ~101 MB |
| 5 | 5/5 | ~35% | ~138 MB |

### 5.3 Media ceiling ramp (Prometheus + CPU, 30s) — **FINAL**

Nguồn: `evidence/capacity-runs/vps-ceiling-FINAL-SUMMARY.md` (copy từ VPS `vps-ceiling-20260806-093912`).

| Rooms | OK | Fail | LiveKit CPU mid % | LiveKit mem | Mbps total (approx) |
|---:|---:|---:|---:|---|---:|
| 1 | 1 | 0 | 15.46 | ~75 MB | **17.6** |
| 3 | 3 | 0 | 23.59 | ~106 MB | **30.8** |
| 5 | 5 | 0 | 33.18 | ~141 MB | **49.1** |
| 8 | 8 | 0 | 53.43 | ~188 MB | **52.8** |
| 10 | 10 | 0 | 50.27 | ~171 MB | **61.3** |
| 12 | 12 | 0 | 60.24 | ~179 MB | **59.8** |
| 15 | 15 | 0 | 47.25 | ~187 MB | **60.5** |
| 18 | 18 | 0 | 53.13 | ~177 MB | **51.8** |
| 20 | 20 | 0 | 55.17 | ~217 MB | **60.4** |
| 25 | 25 | 0 | **72.83** (peak mid) | ~240 MB | **59.3** |
| **30** | **30** | **0** | 60.90 | ~243 MB | **64.4** (peak total) |

**Kết luận ceiling script:** soft end — **N=30**, 0 process fail, CPU mid max quan sát **~73%** (không đạt ngưỡng dừng 180%).  
**Mbps in/out ví dụ (N=18):** in ≈ 28.7, out ≈ 23.2, total ≈ 51.8.

### 5.4 Giải thích hiện tượng “8 room ≈ 15 room về Mbps”

- Tổng throughput **bão hòa ~50–60 Mbps** từ khoảng N≥8–10.  
- Khi tăng room, **bitrate/room giảm** (adaptive/CPU share), tổng không tăng tuyến tính.  
- CPU/RAM vẫn tăng xu hướng; process vẫn OK → “sống được nhiều room” ≠ “mỗi room vẫn HD”.

### 5.5 Call browser thật (3 cuộc >5 phút — phân tích telemetry server)

**Chi tiết:** `evidence/perf-real/2026-08-06-three-real-calls-analysis.md`

| Run | Duration | br_in p50 (kbps) | RTT p50 (ms) | loss p50 | fps_in p50 | Ghi chú >5’ |
|---:|---:|---:|---:|---:|---:|---|
| 1 `282fcc93…` | **10.5’** | 898 | 8 | **0** | 28 | Late br_in **không giảm** vs early |
| 2 `801cddf1…` | **12.3’** | 897 | 7 | **0** | 27 | Path TCP prflx→host |
| 3 `2221c577…` | **11.1’** | 962 | 9 | **0** | 29 | A1 Windows + A2 iPhone (env) |

**Call >5 phút (thực nghiệm):** token 60’ hoạt động; **không** rớt media tại phút 5; early vs late RTT ổn; bitrate late thậm chí cao hơn (warm-up HD).  
**ICE:** hầu hết `protocol=tcp` (fallback), RTT lab vẫn thấp.

### 5.6 Recording (tham chiếu cũ, không re-run ladder)

- E2E CLI demo publisher: start/stop/download OK; cross-tenant 404.  
- Sample file ~9s ~3.3 MB (evidence 2026-08-05).  
- **Không** gộp vào kết luận capacity concurrent lần này.

---

## 6. Yếu tố ảnh hưởng (checklist “tất tần tật”)

| Nhóm | Yếu tố | Đã kiểm / ghi nhận |
|---|---|---|
| **Compute** | Số vCPU, steal time cloud | 2 vCPU; steal không đo |
| | RAM / swap | ~4G; swap có |
| | CPU LiveKit vs backend | LiveKit chiếm tải media; API nhẹ |
| **Network VPS** | Bandwidth plan / fair use | **Chưa** có số Mbps ISP plan |
| | UDP open 50000–50 | Cấu hình có; firewall cloud cần đúng |
| | TURN vs host path | Config TURN; % relay **chưa** đo call thật |
| **Network client** | Wi‑Fi isolation, 4G, VPN | Ảnh hưởng call thật; capacity CLI local-to-SFU |
| | RTT / loss client | Chỉ từ quality panel call thật (TBD) |
| **Codec / app** | Simulcast, max bitrate, resolution | 720p target; adaptive |
| | Token TTL, busy, in-memory | Đã mô tả §3.4 |
| **Topology test** | CLI 2 pub+2 sub / room | Nặng hơn 1:1 tối thiểu |
| | Load generators on same host as SFU | **Có** — CLI chạy **trên VPS** → tranh CPU với LiveKit (kết quả **conservative** / thiên về “máy vừa encode vừa SFU”) |
| **Ops** | Deploy/restart | Mất call in-memory; LiveKit recreate rớt media |
| | sslip / cert | Demo OK; production domain sau |
| **Security** | JWT, tenant | Có; secret demo không production-grade |
| **Observability** | Prometheus 6789 | Bật sau recreate |
| | Quality export | Browser path |

**Điểm quan trọng cho sếp:**  
Load CLI chạy **cùng máy** với LiveKit → CPU gồm cả encode giả lập. Production client encode **tại laptop/phone**, SFU chủ yếu forward → capacity “thuần SFU” có thể **khác** (thường đỡ nặng encode phía server, nhưng TURN vẫn nặng).

---

## 7. Kết luận

### 7.1 Kết luận kỹ thuật (tạm)

1. **PoC đủ để demo call 1:1 multi-network** trên VPS nhỏ (2C/4G), có HTTPS, JWT, presence, đo quality.  
2. **Signaling/API** chịu **≥ 8 concurrent call lifecycle** không lỗi trong test.  
3. **SFU + CLI media:**  
   - Process **không fail** suốt ladder **1…30 room** (2 pub + 2 sub/room, 30s/level) — **soft max N=30**.  
   - **Tổng media ~50–65 Mbps** bão hòa từ ~N=8–10; peak **~64 Mbps @ N=30**.  
   - CPU mid cao nhất **~73% @ N=25** — chưa full 2 core; trần lần này là **bitrate/adaptive**, không sập process.  
   - **Không** claim “30 call HD end-user”.  
4. **Vận hành PoC:** demo/pilot **vài call (1–5)** + quality panel.  
5. **Call cam 2 máy** — **bắt buộc** bổ sung 3–4 run trước khi chốt business.

### 7.2 Kết luận nghiệp vụ (gợi ý cách nói)

> Em đã dựng PoC call 1:1 trên VPS 2CPU/4GB, JWT cơ bản, đo tải tới **30 session media giả** (process vẫn OK).  
> **Bitrate tổng bão hòa ~50–65 Mbps** từ khoảng 8–10 cuộc giả — nên pilot HD chỉ nên **vài cuộc đồng thời** trên máy này.  
> Em sẽ bổ sung đo call 2 máy thật (3–4 lần × 5 phút) để có RTT/bitrate phía user.

### 7.3 Khuyến nghị bước tiếp

| Ưu tiên | Việc | Owner gợi ý |
|---:|---|---|
| 1 | ~~Chốt ceiling~~ → **soft max N=30** (đã ghi §5.3) | Done |
| 2 | PERF browser × 3–4 × 5–15’ + aggregate CSV | Kỹ thuật + 2 máy |
| 3 | (Tuỳ) ramp N>30 hoặc bật recording để tìm fail cứng | Kỹ thuật |
| 4 | (Tuỳ) 1 lần PERF khác mạng (4G vs Wi‑Fi) | Kỹ thuật |
| 5 | Dọn `lk-cap-proxy` / process load-test trên VPS nếu còn | Ops |
| 6 | Production: domain, OS mới hơn, DB, retention recording | Kiến trúc / sau PoC |
| 7 | Nếu cần >10 call HD: VPS mạnh hơn hoặc tách SFU / giảm resolution | Quyết định đầu tư |

---

## 8. Phụ lục

### 8.1 Tài liệu liên quan trong repo

| File | Nội dung |
|---|---|
| `docs/real-world-test-protocol.md` | Call thật × 3–4 lần |
| `docs/capacity-load-testing.md` | Script load |
| `docs/performance-test-plan.md` | Metric 5 phút |
| `docs/vps-deploy.md` | Deploy / port |
| `docs/recording-storage-development-plan.md` | Roadmap ghi hình |
| `evidence/capacity-runs/vps-live-20260806-SUMMARY.md` | Short ladder |
| VPS: `evidence/capacity-runs/vps-ceiling-*/SUMMARY.md` | Ceiling ramp |

### 8.2 Lệnh tham chiếu (không bắt buộc cho sếp)

```text
# Call thật: UI → badge chất lượng → Tải CSV / Kết thúc + tải
# Export lại:
.\scripts\export-quality.ps1 -CallId <uuid> -ApiUrl https://103.28.32.118.sslip.io -UserId A1

# Capacity (đã chạy trên VPS):
# /tmp/vps-capacity-ceiling.sh
```

### 8.3 Changelog trạng thái test (cập nhật tay)

| Thời điểm | Sự kiện |
|---|---|
| 2026-08-06 | Deploy JWT + quality export; API load 8/8; media short 5/5 |
| 2026-08-06 | Ceiling ramp **N=1…30 all OK** (soft end); peak Mbps ~64; peak CPU mid ~73% @25 |
| TBD | Browser PERF aggregate (3–4 × 5’) |

### 8.4 Chữ ký / phê duyệt

| Vai trò | Họ tên | Ngày | Ký |
|---|---|---|---|
| Người thực hiện | | | |
| Review kỹ thuật | | | |
| Lãnh đạo | | | |

---

*Hết bản DRAFT (capacity đã chốt soft max). Cập nhật §5.5 + §7 sau khi có CSV call browser 3–4 lần.*
