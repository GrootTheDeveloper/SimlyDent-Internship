# BÁO CÁO PoC VIDEO CALL 1:1

**Môi trường:** VPS **2 vCPU / ~4 GB RAM**, LiveKit self-host.  
**URL demo:** https://103.28.32.118.sslip.io/  
**Ngày số liệu:** 2026-08-06  

> **TB** trong bảng = **trung vị (p50)** từ telemetry server (sample ~2s, gộp 2 phía A1+A2), trừ khi ghi chú khác.  
> **CPU %** container theo `docker stats`: **100% ≈ 1 full core**; máy **2 vCPU** nên mức “full host” thường quanh **~200%** nếu một process chiếm cả hai core.

## 0. Hạ tầng CPU / RAM (máy chủ)

### 0.1 Thông số máy

| Hạng mục | Giá trị |
| --- | --- |
| CPU | **2 vCPU** |
| RAM host | **~3.9 GiB** (+ Swap **2 GiB**) |
| OS | Ubuntu 18.04 LTS |
| Vai trò tải media | LiveKit SFU (container `livekit`) |

### 0.2 Stack khi **idle** (không load test, sau khi dọn)

| Container | CPU | RAM dùng | % RAM limit (~3.85 GiB) |
| --- | ---: | ---: | ---: |
| **LiveKit** | ~0.3% | ~**58 MB** | ~1.5% |
| Backend (.NET) | ~0.1% | ~**88 MB** | ~2.2% |
| Gateway (Caddy) | ~0% | ~**14 MB** | ~0.4% |
| Frontend (nginx) | ~0% | ~**4 MB** | ~0.1% |
| Redis | ~0.8% | ~**5 MB** | ~0.1% |
| **Host (ước)** | — | used ~**0.5–0.6 GB** / available ~**3 GB** | — |

→ **Baseline rất nhẹ**: cả stack idle dưới **~170 MB** container app + LiveKit.

### 0.3 Ghi chú cách đọc số CPU/RAM lúc load

| Ý | Giải thích |
| --- | --- |
| CPU LiveKit trong bảng §2 | Sample **giữa** mỗi mức load (`docker stats` mid level) |
| RAM LiveKit | Memory **container LiveKit** (không gồm RAM process `lk` load-test trên host) |
| Load CLI | Chạy **cùng VPS** với SFU → encode giả + SFU **tranh CPU** (kết quả thiên conservative) |
| Call cam 1:1 thật | **Không** ghi liên tục CPU host từng giây; quan sát: 1 call không làm server “nặng” như 10–30 room giả |

## 1. Kết quả 3 cuộc gọi thực tế

| Call | Thời lượng | Bitrate In TB | RTT TB | RTT Max | Packet Loss TB | FPS |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Call 1 | **10.5 phút** | 898 Kbps | **8 ms** | 94 ms | **0%** | 28 |
| Call 2 | **12.3 phút** | 897 Kbps | **7 ms** | 128 ms | **0%** | 27 |
| Call 3 | **11.1 phút** | 962 Kbps | **9 ms** | 123 ms | **0%** | 29 |

Kết quả thực tế: **3/3 cuộc gọi đều duy trì trên 10 phút**, RTT trung vị **7–9 ms**, packet loss trung vị **0%**.

### Độ ổn định sau phút thứ 5

| Call | Bitrate 0–2 phút | Bitrate sau phút 5 | RTT đầu | RTT sau phút 5 | Loss |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10.5 phút | 809 Kbps | **2,466 Kbps** | 9 ms | **8 ms** | 0% |
| 12.3 phút | 795 Kbps | **2,456 Kbps** | 8 ms | **7 ms** | 0% |
| 11.1 phút | 809 Kbps | **2,424 Kbps** | 8 ms | **8 ms** | 0% |

Sau phút thứ 5, **không rớt media, không tăng loss và bitrate không suy giảm** (thực tế bitrate late còn cao hơn giai warm-up).

## 2. Kết quả chịu tải media + CPU/RAM chi tiết

Bài test sử dụng media giả với **2 publisher + 2 subscriber/room** (CLI `lk load-test` trên VPS), mỗi mức **30 giây**.

### 2.1 Bảng tổng hợp (mức chính)

| Room đồng thời | Kết quả | CPU LiveKit (mid) | RAM LiveKit (mid) | Tổng bandwidth |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 OK | 15.5% | ~75 MB | 17.6 Mbps |
| 5 | 5/5 OK | 33.2% | ~141 MB | 49.1 Mbps |
| 10 | 10/10 OK | 50.3% | ~171 MB | 61.3 Mbps |
| 20 | 20/20 OK | 55.2% | ~217 MB | 60.4 Mbps |
| 25 | 25/25 OK | **72.8%** | ~240 MB | 59.3 Mbps |
| **30** | **30/30 OK** | 60.9% | ~243 MB | **64.4 Mbps** |

### 2.2 CPU / RAM LiveKit theo full ladder (N = 1…30)

| Room | OK | CPU LiveKit mid | RAM LiveKit mid | Mbps total ~ |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 1/1 | **15.5%** | **~75 MB** | 17.6 |
| 3 | 3/3 | 23.6% | ~106 MB | 30.8 |
| 5 | 5/5 | 33.2% | ~141 MB | 49.1 |
| 8 | 8/8 | 53.4% | ~188 MB | 52.8 |
| 10 | 10/10 | 50.3% | ~171 MB | 61.3 |
| 12 | 12/12 | 60.2% | ~179 MB | 59.8 |
| 15 | 15/15 | 47.3% | ~187 MB | 60.5 |
| 18 | 18/18 | 53.1% | ~177 MB | 51.8 |
| 20 | 20/20 | 55.2% | ~217 MB | 60.4 |
| 25 | 25/25 | **72.8%** (peak mid) | ~240 MB | 59.3 |
| 30 | 30/30 | 60.9% | **~243 MB** (peak RAM) | **64.4** |

### 2.3 Đọc CPU / RAM

| Chỉ số | Quan sát | Ý nghĩa |
| --- | --- | --- |
| CPU mid **thấp nhất** (có tải) | ~**15%** @ 1 room | 1 “cuộc” media giả nhẹ với SFU |
| CPU mid **cao nhất** | ~**73%** @ 25 room | ~**0.7 core**; còn headroom so với full ~200% (2 core) |
| CPU @ 30 room | ~**61%** | Không tăng tuyến tính (adaptive / chia sẻ) |
| RAM LiveKit idle → 30 room | **~58 MB → ~243 MB** | Tăng ~**+185 MB**; vẫn nhỏ so với 4 GB host |
| RAM host sau load | available vẫn **~2–3 GB** | **Không** OOM trong test |
| Backend / Redis / Caddy | Trong load: backend ~**60–90 MB**, Redis ~**4–5 MB**, Caddy ~**15–18 MB** (sample short ladder) | Không phải bottleneck RAM |

### 2.4 Kết quả load

* Test đạt **30/30 room, không có room fail**.
* **CPU** chưa chạm trần host; **bandwidth tổng** bão hòa **~50–65 Mbps** từ ~8–10 room (trần thực tế rõ hơn CPU).
* RAM LiveKit **không** phải giới hạn (peak ~**0.24 GB** / 4 GB).
* Vì đây là **media giả** (+ CLI cùng máy), **30 room ≠ 30 cuộc HD thực tế**.

## 3. Kết luận

* PoC đáp ứng được nhu cầu **video call 1:1**.
* **3/3 call thật** chạy ổn định trong **10.5–12.3 phút**.
* RTT trung vị **7–9 ms**, packet loss trung vị **0%**.
* Sau phút 5 không có dấu hiệu suy giảm chất lượng; bitrate phía nhận đạt khoảng **~2.4 Mbps** (p50 late).
* Load test đạt **30/30 room**; CPU LiveKit mid tối đa ~**73%**; RAM LiveKit tối đa ~**243 MB**.
* Tổng bandwidth server bão hòa khoảng **50–65 Mbps** (nút thắt chính khi tăng concurrent, hơn là hết RAM).
* Với VPS **2 vCPU / ~4 GB RAM**, đề xuất pilot khoảng **1–5 cuộc gọi HD đồng thời**.

## 4. Nếu triển khai production

Cần bổ sung **domain chính thức, DB/persistence, backup, chính sách ghi hình/retention** và nâng cấu hình server hoặc tối ưu bitrate/resolution khi cần scale.

---

*Số liệu: telemetry call thật + ceiling load 2026-08-06. Bản đầy đủ hơn (hạ tầng/cổng/phương pháp): `REPORT-TONG-HOP-SEP.md`.*
