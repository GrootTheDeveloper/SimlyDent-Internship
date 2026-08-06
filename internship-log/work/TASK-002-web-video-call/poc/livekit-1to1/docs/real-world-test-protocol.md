# Test trên thật + lặp 3–4 lần (protocol)

Hai lớp test khác nhau — đừng trộn kết luận:

| Lớp | “Thật” nghĩa là gì | Auto? | Dùng để |
|---|---|---|---|
| **A. CLI + Prometheus** | Video giả qua LiveKit (local hoặc VPS), đo Mbps/loss SFU | Có | Ước capacity SFU / CPU |
| **B. Browser thật** | 2 người, camera/mic, Wi‑Fi/4G/VPS | Bán tự động (quality export) | Cảm giác call + RTT/bitrate client |

Số liệu **1 lần** chỉ là mẫu. PoC: lặp **N = 3 hoặc 4**, báo **min / p50 / avg / max** (hoặc “3/4 pass”).

---

## 1. Browser thật (khuyến nghị cho demo sếp)

### Chuẩn bị

| Mục | Local LAN | Multi-network (thật hơn) |
|---|---|---|
| Stack | `scripts/start.ps1` | VPS + `docs/vps-deploy.md` |
| URL | `http://localhost:5173` hoặc `https://LAN:8443` | `https://DOMAIN` / sslip |
| User | A1 / A2, password `Demo@123` | Giống |
| Thiết bị | 2 browser (hoặc laptop + phone) | 2 mạng khác nhau nếu được |

### Scenario mặc định

| ID | Gì | Thời lượng | Lặp |
|---|---|---:|---:|
| PERF-01 | Cùng mạng, 1:1 | **5 phút** | **3–4** |
| PERF-02 | Khác mạng (VPS) | **5 phút** | **3–4** |
| PERF-05 | 3 call ngắn liên tiếp (UI) | ~2 phút × 3 | 1–2 |

Chi tiết metric / sampling: [performance-test-plan.md](performance-test-plan.md).

### Mỗi lần lặp (1 run)

1. Login A1, A2 — cả hai **online**.  
2. A1 gọi A2 → accept → cam/mic OK.  
3. Timer **5:00** (media token TTL mặc định **60 phút** — call dài hơn 5’ OK).  
4. **Trong call:** app **tự** sample WebRTC mỗi 2s và POST lên server. Mở badge HD/SD để xem live; copy **Call ID** nếu cần.  
5. Phút 5: bấm **「Kết thúc + tải」** (trong panel chất lượng) **hoặc** `Tải báo cáo CSV` rồi hangup.  
6. (Tuỳ) máy host:  
   ```powershell
   .\scripts\export-quality.ps1 -CallId "<uuid>" -UserId A1 -RunLabel "PERF-01-run01"
   # VPS:
   .\scripts\export-quality.ps1 -CallId "<uuid>" -UserId A1 -ApiUrl "https://YOUR_DOMAIN" -RunLabel "PERF-01-run01"
   ```  
7. Cool-down **1–2 phút** rồi lặp.  
8. Sau 3–4 run:  
   ```powershell
   .\scripts\aggregate-quality-exports.ps1 -InputDir .\evidence\perf-real\exports
   ```

### Sheet tổng hợp (copy)

Lưu: `evidence/perf-real/PERF-01/AGGREGATE.md`

```text
Scenario: PERF-01 | Stack: local|VPS | N=4
Devices: ...
Network: ...

Run | end OK? | A br_in@2:30 | B br_in@2:30 | A loss@2:30 | A RTT@2:30 | subjective | notes
1   | Y/N     |              |              |             |            | OK/soft/...|
2   |         |              |              |             |            |            |
3   |         |              |              |             |            |            |
4   |         |              |              |             |            |            |

Summary:
- Pass rate (end OK): x/4
- Bitrate in @2:30 (side A): min=  p50=  avg=  max=
- Loss @2:30: min=  p50=  avg=  max=
- RTT @2:30: min=  p50=  avg=  max=
- Claim for boss: "Trong 4 lần, …" — không nói chắc từ 1 lần
```

### Cách “thống kê” PoC (đủ dùng, không cần SPSS)

- **N = 3–4** (không 1, không cần 30 trừ khi nghiên cứu formal).  
- Báo: **tỷ lệ pass** (vd 4/4 hoặc 3/4) + **p50 / avg** bitrate & RTT tại t=2:30.  
- Một lần fail: ghi nguyên nhân (mạng, permission, ICE) — không xóa im lặng.  
- Không gộp PERF-01 (LAN) với PERF-02 (cross-net) thành một số.

---

## 2. CLI media lặp (auto, SFU)

Đã có:

```powershell
# 4 lần, ladder 1/3/5 rooms, mỗi lần 25s — gộp min/p50/avg/max
.\scripts\run-repeated-media-load.ps1 -Repetitions 4 -ConcurrentRooms "1,3,5" -DurationSeconds 25
```

Output: `evidence/capacity-runs/media-repeated-*/SUMMARY.md` + `aggregate-report.json`.

- Local Docker ≠ VPS: muốn số “deploy” thì **SSH VPS**, chạy cùng lệnh (mở port 6789 nội bộ hoặc scrape trong container).  
- Vẫn không thay browser RTT.

API concurrent (optional lặp):

```powershell
1..4 | ForEach-Object {
  .\scripts\api-load-test.ps1 -ConcurrentLevels "5,8,10" -HoldSeconds 5 `
    -OutDir ".\evidence\capacity-runs\api-rep-$_"
}
```

(API ít nhiễu hơn media; 2–3 lần thường đủ.)

---

## 3. Thứ tự làm việc đề xuất (1 buổi)

| Bước | Việc | Thời gian ~ |
|---:|---|---|
| 1 | `run-repeated-media-load.ps1 -Repetitions 4` (local hoặc VPS) | 15–25 phút |
| 2 | PERF-01 browser **4 × 5 phút** + sheet aggregate | ~30–40 phút (+ cool-down) |
| 3 | Nếu có VPS/2 mạng: PERF-02 **3 × 5 phút** | ~25 phút |
| 4 | Ghi 1 trang `evidence/perf-real/YYYYMMDD-summary.md` cho sếp | 10 phút |

---

## 4. Nói với sếp (mẫu)

> Em đo **2 lớp**: (1) tải SFU tự động lặp **4 lần** — Mbps/loss ổn định theo p50; (2) call browser thật **3–4 lần × 5 phút** — bitrate/RTT/cảm giác.  
> Không kết luận capacity từ **một** lần.  
> Call qua mạng công ty/4G sẽ khác LAN; PERF-02 là số “thật” multi-network.

---

## 5. Checklist nhanh

**Browser**

- [ ] N=3 hoặc 4 đã chốt trước khi chạy  
- [ ] Cùng scenario / thiết bị / stack giữa các run  
- [ ] Cool-down giữa run  
- [ ] File aggregate + raw notes từng run  
- [ ] Phân biệt LAN vs cross-net  

**CLI**

- [ ] `run-repeated-media-load.ps1 -Repetitions 4`  
- [ ] Đọc p50/avg trong `SUMMARY.md`, không chỉ run-01  

**Không bắt buộc lần này**

- [ ] Recording bật song song  
- [ ] 30 mẫu formal / ANOVA  
