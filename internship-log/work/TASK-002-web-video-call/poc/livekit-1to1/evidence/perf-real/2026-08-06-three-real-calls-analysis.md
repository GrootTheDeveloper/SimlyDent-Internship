# Phân tích 3 cuộc gọi thật (telemetry VPS) + call > 5 phút

**Nguồn:** `telemetry/call-*/A1-*.jsonl` + `A2-*.jsonl` trên VPS (server tự nhận sample mỗi ~2s từ browser).  
**Ngày:** 2026-08-06 (UTC).  
**Phương pháp:** gộp 2 phía A1+A2; p50/avg/min/max; so early (0–2’) vs late (>5’ / 65% thời lượng).

> Trước đó report chỉ có **phân tích rủi ro cấu hình** (token 5’→60’, busy stale).  
> **Đây mới là phân tích số đo thật** từ 3 call dài.

---

## 1. Ba cuộc gọi (đủ > 5 phút)

| # | Call ID (rút) | Thời lượng | Samples | Ghi chú |
|---:|---|---:|---:|---|
| 1 | `282fcc93…` | **10.5 phút** | 563 | Call treo/đo dài trước đó |
| 2 | `801cddf1…` | **12.3 phút** | 669 | Dài nhất |
| 3 | `2221c577…` | **11.1 phút** | 603 | |
| (thêm) | `1e29e991…` | **7.3 phút** | 376 | Call thứ 4 trong telemetry sáng |

User: **A1 + A2** (tenant-a).  
Thiết bị (từ environment 1 phía): **Windows 4 core / 8GB**, cam 1280×720; phía kia log **iPhone** portrait 720×1280.  
Mạng browser: `networkType=4g`, downlink báo **1.25 Mbps** (Network Information API — chỉ tham khảo, không phải throughput WebRTC thực).

---

## 2. Chỉ số tổng (cả call)

| Call | br_in p50 (kbps) | br_in avg | br_out p50 | RTT p50 (ms) | RTT max | loss p50 | fps_in p50 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 10.5’ | 898 | 1631 | 896 | **8** | 94 | **0** | 28 |
| 12.3’ | 897 | 1639 | 2502* | **7** | 128 | **0** | 27 |
| 11.1’ | 962 | 1635 | 879 | **9** | 123 | **0** | 29 |
| 7.3’ | 867 | 1629 | 2497* | **8** | 123 | **0** | 27 |

\* `br_out` p50 cao ~2500 trên một số call vì **một phía** publish mạnh (thường desktop→phone); phía kia nhận/portrait nên phân bố 2 hướng lệch. Avg ~1.6 Mbps in là hợp lý cho 720p adaptive.

**Đường truyền ICE (cả 3):** gần như 100% **`protocol=tcp`**, candidate **`prflx → host`**.  
→ Media **không** đi UDP host–host thuần; có TCP fallback (firewall/NAT). Vẫn RTT thấp (p50 7–9 ms) → hai đầu **gần VPS / cùng khu vực mạng**, không phải xuyên lục địa.

---

## 3. Call **> 5 phút** — có tụt chất lượng không?

### 3.1 So early (0–2’) vs late (sau 5’ / cuối call)

| Call | Early br_in p50 | Late br_in p50 | Early RTT p50 | Late RTT p50 | Loss |
|---|---:|---:|---:|---:|---|
| 10.5’ | 809 | **2466** | 9 | **8** | 0→0 |
| 12.3’ | 795 | **2456** | 8 | **7** | 0→0 |
| 11.1’ | 809 | **2424** | 8 | **8** | 0→0 |
| 7.3’ | 815 | **2474** | 8 | **9** | 0→0 |

**Kết luận thực nghiệm:**

1. **Không** thấy suy giảm bitrate sau phút 5 — late thậm chí **cao hơn** early (ổn định simulcast/HD sau warm-up).  
2. **RTT ổn định** (p50 7–9 ms); max spike ~90–128 ms thỉnh thoảng, không kéo dài.  
3. **Packet loss p50 = 0%** toàn bộ call dài.  
4. **Không đứt media** sau phút 5: max chuỗi sample “gần 0 bitrate” sau khi đã có media chỉ **1–2 sample (~2–4 s)** — nhiễu thống kê, không phải drop 5’ token.

### 3.2 Bucket 5–15 phút (trong call)

Ví dụ call 12.3’:

| Phase | br_in p50 | br_out p50 | rtt p50 | loss |
|---|---:|---:|---:|---:|
| 0–1’ | 784 | 2499 | 8 | 0 |
| 1–5’ | 860 | 2501 | 7 | 0 |
| **5–15’** | **2419** | **2504** | **7** | **0** |

Sau 5 phút media **vẫn full**; token **60 phút** đã có hiệu lực (nếu vẫn 5’ TTL cũ, kỳ vọng rớt quanh phút 5 — **không xảy ra**).

### 3.3 Hạ tầng / app khi call >5’ (đối chiếu cấu hình)

| Yếu tố | Trước / rủi ro lý thuyết | Quan sát 3 call >5’ |
|---|---|---|
| LiveKit join token | Từng **5 phút** → rớt media | Đã **60’**; call **7–12’ không rớt** |
| Busy stale Accepted 2’ | Từng auto-end khi có call mới | Đã sửa; call dài vẫn Accepted |
| CPU/RAM VPS 1 call | Nhẹ | Telemetry client ổn; không freeze hàng loạt |
| TCP path | Có thể kém hơn UDP | RTT thấp, loss 0 — **OK trong lab này** |
| Memory leak browser | Call dài có thể phình tab | **Chưa** đo heap; subjective user tự ghi |
| Quality log volume | ~2s/sample × 2 user × 12’ ≈ hàng trăm dòng | Server ghi disk ổn (~0.5–1 MB/call) |

---

## 4. Kết luận gửi sếp (call thật)

1. **Đã có 3 cuộc gọi thật > 5 phút** (thực tế **~10–12 phút**), A1↔A2, telemetry server đầy đủ.  
2. **Sau phút 5 không suy giảm** bitrate/RTT; loss ~0; media liên tục.  
3. Chất lượng lab: **720p-class**, bitrate phía nhận p50 ~0.9–2.5 Mbps tùy hướng, **RTT p50 ~7–9 ms**, fps ~27–29.  
4. Path **TCP + prflx** — phù hợp firewall; production cần thêm case **UDP/4G yếu** để so.  
5. **Chưa** đo formal “3 run đúng protocol 5:00 stop + export CSV tay”, nhưng **dữ liệu server đã đủ** để kết luận **call >5’ khả thi** trên PoC hiện tại (token 60’).

---

## 5. Hạn chế phân tích

- Gộp A1+A2 trong cùng stats → avg/p50 trộn 2 phía (desktop vs iPhone).  
- `networkType=4g` / downlink 1.25 từ browser API **không** khớp bitrate WebRTC thực tế (~Mbps).  
- Capacity CLI 30 room **không** liên quan trực tiếp 3 call này (1 call cam).  
- Subjective A/V (tiếng echo, portrait letterbox) cần user ghi tay.

---

## 6. Call ID đầy đủ (đối chiếu)

1. `282fcc93-99e6-43b4-971e-e143a034c07c` — 10.51 min  
2. `801cddf1-5753-422b-b1b6-ff0ac5e70e4c` — 12.25 min  
3. `2221c577-fb30-40b6-a80b-682902db7d33` — 11.14 min  
4. (phụ) `1e29e991-f6ce-453b-b031-bca9efd2393b` — 7.34 min  
