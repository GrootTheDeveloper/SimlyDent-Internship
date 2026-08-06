# BÁO CÁO TỔNG HỢP — PoC Video Call 1:1 (LiveKit)

**Một file duy nhất** cho lãnh đạo: hạ tầng · phương pháp · capacity · 3 call thật (>5’) · kết luận.

| | |
|---|---|
| **Ngày** | 2026-08-06 |
| **Trạng thái** | Bản tổng hợp kỹ thuật (có thể copy Word/PDF) |
| **Git / VPS** | `563f23e` · https://103.28.32.118.sslip.io/ |
| **Demo login** | A1 / A2 · mật khẩu `Demo@123` |

---

# Phần A — Tóm tắt 1 trang

## A.1 Đã triển khai

1. Video call **1:1 web** self-host: LiveKit SFU + .NET API + Vue UI.  
2. Deploy **VPS public**, HTTPS (sslip.io), **TURN**, client **khác mạng** có thể gọi.  
3. **JWT login**, tách tenant, online/offline (SignalR).  
4. Call thật **tự đo** bitrate / loss / RTT (ghi server + tải CSV).  
5. Đo **chịu tải server** (API concurrent + media giả ladder tới 30 room).  
6. CI/CD: push GitHub → deploy VPS.

## A.2 Kết luận chính (để nói với sếp)

| Chủ đề | Kết luận | Độ tin |
|---|---|---|
| **Call 1:1 thật** | 3 cuộc **~10–12 phút**, A1↔A2: loss ~**0%**, RTT p50 **7–9 ms**, sau phút 5 **không rớt / không tụt** chất lượng | **Cao** (telemetry server) |
| **Call > 5 phút** | Token media **60’**; thực nghiệm **7–12’** ổn | **Cao** |
| **API / signaling** | **8 cặp** create–accept–end đồng thời **100%** | **Cao** |
| **Nhiều call media (giả)** | **30/30 room OK**; tổng bitrate bão hòa **~50–65 Mbps** từ ~8–10 room | **Cao** |
| **HD đồng thời cho user** | Trên VPS 2CPU/4GB nên pilot **vài cuộc** (1–5), **không** claim 30 call HD | Trung (suy từ Mbps/adaptive) |
| **Ghi hình production** | PoC có Egress; chưa consent/retention/S3 | Chưa đủ |

## A.3 Một đoạn gửi sếp

> Em đã dựng PoC gọi video 1:1 trên VPS 2 CPU / 4 GB, có HTTPS và đăng nhập JWT.  
> **Ba cuộc gọi thật** (mỗi cuộc khoảng 10–12 phút) đo được: độ trễ trung vị ~8 ms, mất gói ~0%, sau phút 5 vẫn ổn.  
> **Tải server** (video giả): xử lý tới 30 phòng song song không sập process, nhưng tổng băng thông media bão hòa khoảng 50–65 Mbps — nên vận hành pilot chỉ nên vài cuộc HD cùng lúc.  
> Bước tiếp: domain công ty, DB, chính sách ghi hình; scale thì nâng VPS hoặc giảm bitrate.

---

# Phần B — Hạ tầng & yếu tố ảnh hưởng

## B.1 Máy chủ VPS

| Hạng mục | Giá trị |
|---|---|
| Public IP | **103.28.32.118** |
| Domain demo | **103.28.32.118.sslip.io** |
| OS | Ubuntu **18.04** LTS |
| CPU | **2 vCPU** |
| RAM | **~3.9 GiB** (+ swap 2 GiB) |
| Disk | ~50 GB (plan) |
| Hostname lab | vpssieutoc… (Siêu Tốc / GOLD 4 class) |

## B.2 Stack phần mềm

| Thành phần | Phiên bản / tech | Vai trò |
|---|---|---|
| LiveKit Server | **1.13.1** | SFU + TURN |
| Redis | 7.4 | Phối hợp LiveKit |
| Backend | ASP.NET Core | Call, JWT, SignalR, quality API |
| Frontend | Vue 2.7 + livekit-client | UI |
| Gateway | Caddy 2 | HTTPS |
| Egress | 1.12 (tuỳ chọn) | Ghi MP4 |
| Deploy | Docker Compose + GitHub Actions | CD |

## B.3 Mạng / cổng

| Cổng | Mục đích |
|---|---|
| 80, 443 TCP | UI + API + signaling HTTPS |
| 7881 TCP | WebRTC TCP fallback |
| 3478 TCP/UDP | TURN |
| 50000–50050 UDP | Media WebRTC (~51 port) |
| 6789 (nội bộ) | Prometheus metrics LiveKit |

**STUN** public Google; **TURN** bật trên VPS; **PUBLIC_IP** = 103.28.32.118.

## B.4 Cấu hình app ảnh hưởng chất lượng

| Tham số | PoC |
|---|---|
| Mục tiêu video | ~720p / 30fps, max ~2.5 Mbps, VP8, simulcast |
| Adaptive / dynacast | Bật (tự giảm khi yếu) |
| Join token LiveKit | **60 phút** (trước từng 5’ — dễ rớt call dài) |
| JWT đăng nhập | ~480 phút |
| Busy | 1 user = 1 call active |
| State call | **RAM** (restart backend mất call) |

## B.5 Checklist yếu tố ảnh hưởng

| Nhóm | Yếu tố |
|---|---|
| Compute | 2 vCPU, 4 GB, steal time cloud (chưa đo) |
| Mạng VPS | Băng thông plan ISP (chưa số hợp đồng); UDP range hẹp |
| Mạng client | Wi‑Fi isolation, 4G, VPN, firewall → TURN/TCP |
| Client | CPU laptop/phone, quyền cam/mic, browser |
| Topology test | CLI load **cùng máy** SFU → encode giả + SFU tranh CPU |
| Ops | Restart / deploy cắt call in-memory |
| Bảo mật | JWT demo; secret demo không production |

---

# Phần C — Phương pháp đo (2 lớp, không trộn)

| Lớp | Cách làm | Ý nghĩa |
|---|---|---|
| **A. Call thật** | 2 máy browser A1–A2, cam/mic; sample ~2s → server | UX + bitrate/RTT/loss người dùng |
| **B. Capacity** | `lk load-test`: N room × 2 publisher video giả + 2 subscriber | Sức SFU / CPU / Mbps tổng |

---

# Phần D — Kết quả capacity (server)

## D.1 API concurrent (JWT, user L01…)

| Cặp đồng thời | Thành công | Thời gian wall ~ |
|---:|---:|---:|
| 1 | 100% | 4.0 s |
| 3 | 100% | 4.4 s |
| 5 | 100% | 5.3 s |
| **8** | **100%** | 6.5 s |

→ Signaling **không** phải nút thắt.

## D.2 Media giả — ceiling N = 1 … 30 (30s/level)

Mỗi room: **2 video publishers + 2 subscribers**, resolution high, CLI trên VPS.

| Rooms | OK | Fail | LiveKit CPU mid % | RAM LiveKit | Mbps total ~ |
|---:|---:|---:|---:|---|---:|
| 1 | 1 | 0 | 15.5 | ~75 MB | **17.6** |
| 3 | 3 | 0 | 23.6 | ~106 MB | **30.8** |
| 5 | 5 | 0 | 33.2 | ~141 MB | **49.1** |
| 8 | 8 | 0 | 53.4 | ~188 MB | **52.8** |
| 10 | 10 | 0 | 50.3 | ~171 MB | **61.3** |
| 12 | 12 | 0 | 60.2 | ~179 MB | **59.8** |
| 15 | 15 | 0 | 47.3 | ~187 MB | **60.5** |
| 18 | 18 | 0 | 53.1 | ~177 MB | **51.8** |
| 20 | 20 | 0 | 55.2 | ~217 MB | **60.4** |
| 25 | 25 | 0 | **72.8** | ~240 MB | **59.3** |
| **30** | **30** | **0** | 60.9 | ~243 MB | **64.4** |

**Kết luận capacity**

- **Soft max N=30**: hết ladder, **0 process fail**; CPU mid max ~**73%** (chưa full ~200% trên 2 core).  
- **Mbps tổng bão hòa ~50–65 Mbps** từ ~8–10 room → tăng room **không** tăng bitrate tuyến tính (mỗi room “gầy” hơn).  
- **Không** đồng nghĩa 30 call HD cho user thật.

**Ví dụ N=18:** `mbps_in≈28.7` · `mbps_out≈23.2` · `total≈51.8` · `ok=18` · `cpu_mid≈53%` · `mem≈177MB`.

---

# Phần E — Kết quả 3 cuộc gọi THẬT (cam/mic)

**Nguồn:** telemetry server `telemetry/call-*/` (tự ghi khi user gọi).

## E.1 Bảng 3 call chính

| # | Call ID | Thời lượng | Samples | br_in p50 | br_in avg | RTT p50 | RTT max | loss p50 | fps_in p50 |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `282fcc93-99e6-43b4-971e-e143a034c07c` | **10.5’** | 563 | 898 | 1631 | **8** | 94 | **0** | 28 |
| 2 | `801cddf1-5753-422b-b1b6-ff0ac5e70e4c` | **12.3’** | 669 | 897 | 1639 | **7** | 128 | **0** | 27 |
| 3 | `2221c577-fb30-40b6-a80b-682902db7d33` | **11.1’** | 603 | 962 | 1635 | **9** | 123 | **0** | 29 |

*(Thêm trong log: call `1e29e991…` ~**7.3’**, cùng xu hướng.)*

- User: **A1, A2**.  
- Client: Windows 1280×720 + iPhone portrait 720×1280.  
- ICE: gần 100% **`tcp`**, **`prflx → host`**.

## E.2 Call > 5 phút (so early 0–2’ vs late)

| Call | Early br_in p50 | Late br_in p50 | Early RTT p50 | Late RTT p50 | Loss |
|---|---:|---:|---:|---:|---|
| 10.5’ | 809 | **2466** | 9 | **8** | 0 |
| 12.3’ | 795 | **2456** | 8 | **7** | 0 |
| 11.1’ | 809 | **2424** | 8 | **8** | 0 |

**Kết luận call dài**

1. Sau phút 5: **không rớt media**, **không tăng loss**.  
2. Bitrate late **không kém** early (thường cao hơn sau warm-up HD).  
3. Token **60 phút** có hiệu lực (call 10–12’ ổn).  
4. RTT lab rất thấp — case mạng xa/yếu **chưa** có trong 3 call này.

## E.3 Ví dụ ổn định trong call 12.3’

| Phase | br_in p50 | br_out p50 | rtt p50 | loss |
|---|---:|---:|---:|---:|
| 0–1’ | 784 | 2499 | 8 | 0 |
| 1–5’ | 860 | 2501 | 7 | 0 |
| **5–15’** | **2419** | **2504** | **7** | **0** |

---

# Phần F — Kết luận & khuyến nghị

## F.1 Kỹ thuật

1. PoC **đủ demo** call 1:1 multi-network + auth + đo chất lượng.  
2. **1 call cam dài 10–12’** trên VPS nhỏ: **ổn** (loss 0, RTT thấp).  
3. **Nhiều session media giả:** sống được tới **30**, nhưng **Mbps tổng kẹt ~50–65** → không quảng cáo “30 HD”.  
4. API concurrent **≥ 8** ổn.  
5. Hạn chế PoC: in-memory, Ubuntu 18.04, domain demo, JWT/secret demo, chưa recording policy.

## F.2 Vận hành / đầu tư

| Ưu tiên | Việc |
|---:|---|
| 1 | Pilot: **1–5 call** HD + theo dõi quality panel |
| 2 | Production: domain công ty, OS mới, DB, backup |
| 3 | Ghi hình: consent, retention, object storage (xem plan recording) |
| 4 | Scale > vài call HD: VPS mạnh hơn **hoặc** giảm bitrate/resolution |
| 5 | Bổ sung test: mạng yếu / 4G thật / 2 ISP (TURN share) |

## F.3 Việc đã xong vs còn mở

| Hạng mục | Trạng thái |
|---|---|
| Deploy VPS + JWT + quality auto | Xong |
| Capacity ladder N≤30 | Xong (soft max) |
| 3 call thật >5’ + phân tích | Xong (telemetry) |
| Recording production | Chưa |
| SLA / TCO | Không bịa số |

---

# Phần G — Phụ lục

## G.1 URL & tài khoản demo

- https://103.28.32.118.sslip.io/  
- A1 / A2 / A3 (tenant-a), B1 (tenant-b) · `Demo@123`

## G.2 File chi tiết (nếu cần đào sâu — không bắt buộc)

| Nội dung | Đường dẫn |
|---|---|
| **File này (tổng hợp)** | `poc/livekit-1to1/REPORT-TONG-HOP-SEP.md` |
| Bản report dài (cũ, trùng một phần) | `docs/reports/2026-08-06-boss-performance-capacity-report.md` |
| Phân tích 3 call | `evidence/perf-real/2026-08-06-three-real-calls-analysis.md` |
| Ceiling raw | `evidence/capacity-runs/vps-ceiling-FINAL-SUMMARY.md` |
| Protocol test | `docs/real-world-test-protocol.md` |
| Deploy | `docs/vps-deploy.md` |

## G.3 Chữ ký

| Vai trò | Họ tên | Ngày | Ký |
|---|---|---|---|
| Người thực hiện | | | |
| Review | | | |
| Lãnh đạo | | | |

---

*Hết báo cáo tổng hợp — 2026-08-06.*
