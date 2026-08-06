# Script thuyết trình báo cáo PoC Video Call 1:1

**Thời lượng gợi ý:** 4–6 phút  
**Tài liệu:** `REPORT-GUI-SEP.md` / PDF `TASK-002-PoC-Video-Call-Ket-Qua.pdf`  
**Giọng:** ngắn, số liệu trước, kết luận sau — không kể hậu trường.

---

## 0. Mở đầu (~20 giây)

> Em báo cáo kết quả PoC **video call 1:1** self-host bằng LiveKit trên VPS.  
> Phạm vi: **cuộc gọi thật** hai máy và **đo chịu tải** server.  
> Môi trường: **2 vCPU, khoảng 4 GB RAM**, URL demo đã deploy.

---

## 1. Cuộc gọi thật (~1,5 phút)

> Em chạy **ba cuộc gọi thật** A1–A2, mỗi cuộc **trên 10 phút** (10,5 / 12,3 / 11,1 phút).

Chỉ bảng (hoặc slide):

| | RTT trung vị | Loss trung vị | FPS |
|---|---|---|---|
| Cả 3 call | **7–9 ms** | **0%** | **~27–29** |

> Bitrate nhận trung vị khoảng **0,9 Mbps**; sau khi ổn định có lúc đạt khoảng **2,4 Mbps**.

**Sau phút thứ 5:**

> So đầu cuộc gọi và sau phút 5: **không rớt media**, **loss vẫn 0%**, **RTT không xấu đi**, bitrate **không tụt** — thậm chí cao hơn sau giai warm-up.  
> Kết luận: call **dài hơn 5 phút** trên PoC hiện tại **ổn**.

*(Nếu sếp hỏi “TB là gì?”)*  
> TB là **trung vị p50** — giá trị điển hình, không bị một spike làm lệch.

---

## 2. Chịu tải server (~1,5 phút)

> Em đo tải media **giả** trên cùng VPS: mỗi “room” = 2 publisher + 2 subscriber video, tăng dần đến **30 room**.

Chỉ số chốt:

| | |
|---|---|
| Kết quả | **30/30 room OK**, không fail |
| CPU LiveKit (cao nhất mid) | **~73%** @ 25 room |
| RAM LiveKit | idle ~**58 MB** → max ~**243 MB** |
| Bandwidth tổng | bão hòa **~50–65 Mbps** từ khoảng 8–10 room |

> Stack idle rất nhẹ; bottleneck khi scale là **băng thông/bitrate tổng**, không phải hết RAM.  
> **Lưu ý:** 30 room media **giả** **không** đồng nghĩa 30 cuộc **HD thật** cho user.

---

## 3. Kết luận & đề xuất (~1 phút)

> **PoC đạt** mục tiêu call 1:1.  
> **3/3 call thật** ổn **10–12 phút**, RTT thấp, loss 0%, sau phút 5 không suy giảm.  
> Server chịu được nhiều session giả nhưng **Mbps tổng kẹt ~50–65**; trên máy **2C/4G** em đề xuất pilot **1–5 cuộc HD đồng thời**.

**Production cần thêm:** domain chính thức, DB/persistence, backup, chính sách ghi hình/retention; scale thì nâng VPS hoặc hạ bitrate/resolution.

---

## 4. Chốt / mở Q&A (~15 giây)

> Em xin ý kiến sếp cho hướng pilot và hạng mục production ưu tiên. Em sẵn sàng demo call hoặc đi sâu bảng số.

---

## Phụ lục — trả lời nhanh (chỉ khi được hỏi)

| Câu hỏi | Trả lời gọn |
|---|---|
| Ghi hình? | Server-side **LiveKit Egress** → MP4 H.264 720p, thư mục `recordings/`; ~**20+ MB/phút**; VPS chưa bật egress mặc định. |
| Online/offline? | SignalR + JWT; đóng tab = offline. |
| Khác mạng? | VPS public + TURN; lab call thật path **TCP/prflx**. |
| 30 room sao CPU chưa 100%? | Adaptive giảm bitrate/room; trần rõ là **Mbps tổng**, không sập process. |
| Token 5 phút? | Đã **60 phút**; call 10–12’ không cắt. |

---

## Slide gợi ý (5 slide)

1. **Tiêu đề** — PoC Video Call 1:1 · VPS 2C/4G · 06/08/2026  
2. **Call thật** — bảng 3 call + sau phút 5  
3. **Load** — bảng room / CPU / RAM / Mbps  
4. **Kết luận** — đạt 1:1 · pilot 1–5 HD · production checklist  
5. **Q&A**

---

*In xong: đọc to ~4 phút; chừa 1–2 phút hỏi đáp.*
