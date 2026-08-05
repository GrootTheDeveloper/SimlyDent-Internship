# Research method note — đánh giá giải pháp video call web có thể kiểm chứng

Status: Method note, đã đồng bộ terminology sau review ngày 2026-08-04.

Canonical methodology hiện tại:

- [research-protocol.md](../internship-log/work/TASK-002-web-video-call/docs/research-protocol.md)
- [candidate-spike-plan.md](../internship-log/work/TASK-002-web-video-call/docs/candidate-spike-plan.md)
- [evidence-table.md](../internship-log/work/TASK-002-web-video-call/references/evidence-table.md)

Không dùng riêng file này để qualification nếu có khác biệt với các canonical artifacts trên.

Ngày lập: 2026-08-04

## 1. Sửa sai phương pháp

Ma trận điểm 1–5 trước đó không hợp lệ để kết luận vì:

- Không định nghĩa thang đo cho từng điểm.
- Không có trọng số do stakeholder phê duyệt.
- Trộn dữ liệu tài liệu, suy luận kiến trúc và phán đoán cá nhân.
- Chưa chạy cùng một phép thử trên các ứng viên.
- Không công bố bất định và dữ liệu còn thiếu.

ISO/IEC 25023:2016 cung cấp các phép đo chất lượng nhưng không tự gán khoảng giá trị thành cấp/điểm tuân thủ; ngưỡng phải dựa vào loại sản phẩm, mức toàn vẹn và nhu cầu người dùng. Vì vậy không thể lấy tên tính năng rồi tự chuyển thành điểm 1–5.

## 2. Cơ sở phương pháp

- ISO/IEC 25010:2023: mô hình chất lượng sản phẩm dùng để xác định và kiểm tra độ đầy đủ của yêu cầu, mục tiêu test, tiêu chí kiểm soát/acceptance và phép đo.
- ISO/IEC 25040:2024: khung đánh giá chất lượng ICT/software cho developer, acquirer, provider và evaluator.
- ISO/IEC 25023:2016: phép đo định lượng chất lượng sản phẩm, dùng cùng ISO/IEC 25010; không ấn định grade/range chung cho mọi sản phẩm.
- ISO/IEC 25020:2019: khung đo lường, gồm lựa chọn phép đo, đánh giá độ tin cậy/độ giá trị và cách tài liệu hóa phép đo.
- RFC 8825: WebRTC là bộ giao thức real-time cho browser; signaling và media path là các phần logic khác nhau.
- RFC 8445: ICE tìm đường qua NAT và giả định signaling được cung cấp bằng cơ chế khác.
- RFC 8656: TURN relay khi kết nối trực tiếp không khả dụng.
- RFC 8827: kiến trúc bảo mật WebRTC; HTTPS, consent camera/microphone và media được bảo vệ.
- W3C WebRTC Statistics API: nguồn đo khách quan cho packet loss, jitter, bytes/packets, candidate pair và các thống kê media/network.

## 3. Loại bằng chứng

Mỗi kết luận phải gắn một loại bằng chứng:

| Mã | Bằng chứng | Cho phép kết luận |
|---|---|---|
| S | Standard/RFC/W3C/ISO | Cơ chế, yêu cầu chuẩn hoặc phương pháp đánh giá |
| V | Tài liệu chính thức của vendor/project | Tính năng được công bố; không chứng minh hiệu năng thực tế |
| T | Dữ liệu PoC theo protocol công bố trước | Kết quả trong đúng thiết bị/mạng/version đã thử |
| C | Báo giá, hợp đồng, SLA, DPA hoặc văn bản pháp luật | Chi phí/cam kết/pháp lý trong phạm vi văn bản |
| U | Chưa có bằng chứng | Không được suy ra; phải hỏi hoặc thử |

Marketing page của vendor chỉ là bằng chứng V về tuyên bố của vendor. Không dùng nó một mình để kết luận “tốt nhất”, “nhanh nhất”, “ổn định nhất” hoặc “rẻ nhất”.

## 4. Quy trình đánh giá

1. Đóng yêu cầu và phân loại MUST/SHOULD/COULD.
2. Ánh xạ mỗi yêu cầu tới đặc tính chất lượng ISO/IEC 25010 liên quan.
3. Lập candidate set theo các lớp giải pháp, ghi rõ tiêu chí đưa vào/loại ra.
4. Desk research bằng chuẩn và tài liệu chính thức; mọi ô chưa có nguồn ghi U.
5. Loại ứng viên thất bại core MUST gate bằng bằng chứng rõ ràng.
6. Chạy feasibility spike cho U thuộc core gates/application feasibility trước khi đưa ứng viên vào comparative PoC.
7. Công bố raw results, version, cấu hình, thiết bị, mạng và sai lệch protocol.
8. Chỉ sau đó mới lập decision record. Nếu cần trọng số kinh doanh, stakeholder phải phê duyệt trọng số trước khi xem kết quả.

## 5. Core qualification gates từ yêu cầu Project 1

- G1: video call 1:1 giữa hai user đã đăng nhập.
- G2: direct call lifecycle gồm incoming, accept, reject, cancel, busy/no-answer.
- G3: web desktop và mobile web theo browser matrix được chốt.
- G4: hoạt động trong bối cảnh cùng mạng, khác chi nhánh và remote; có cơ chế NAT traversal/TURN.
- G5: provider/platform có identity, token, event hoặc control primitives đủ để backend kiểm soát authorization; secret không nằm ở browser.
- G6: recording không phải core gate; nếu chạy optional recording spike thì phải đánh giá capability, policy và access control riêng.
- G7: pricing/deployment model đủ rõ để xác định cost drivers.

Ứng viên có trạng thái U ở core gate không được xem là đạt; phải xác minh bằng tài liệu, vendor response hoặc PoC.

Application feasibility là phần module/backend của hệ thống phải chứng minh, không đòi vendor hiểu trực tiếp tenant model của SimlyDent:

- caller/callee authorization;
- tenant isolation;
- busy reservation;
- direct-call wrapper nếu provider chỉ cung cấp room/meeting model;
- provider identity mapping;
- module/provider adapter boundary;
- command/callback idempotency.

Workload-based TCO là input cho decision record sau PoC. Nếu chưa có calls/day, minutes/month hoặc concurrency có nguồn, chỉ được trình bày cost drivers, công thức và sensitivity; không dùng TCO để chặn technical feasibility PoC.

## 6. Phép đo PoC

Không dùng điểm cảm tính. Thu các biến quan sát được:

- Số lần initiated/ringing/accepted/connected/completed theo từng scenario.
- Call invitation latency: từ backend ghi nhận initiate tới browser B nhận invitation.
- Answer-to-media latency: từ accept tới first remote audio/video.
- Call setup success rate, có công bố số lần thử N.
- Unexpected disconnect và reconnect time.
- `getStats()` theo thời gian: packets sent/received/lost, jitter, RTT nếu có, bitrate, frame rate/resolution và selected candidate pair.
- ICE path: host/server-reflexive/relay để biết có dùng TURN.
- CPU/memory/battery quan sát được trên thiết bị mục tiêu.
- Recording: thời điểm bắt đầu/kết thúc, file hoàn chỉnh, A/V sync, thời lượng, kích thước và quyền truy cập.
- Functional results cho accept/reject/cancel/busy/timeout/permission denied/background.
- Chi phí theo workload công bố; tách license/provider, compute, bandwidth, storage và operations.

Ngưỡng pass/fail phải được duyệt trước khi chạy test. Nếu chưa có baseline hoặc SLA nghiệp vụ, báo cáo raw values và gắn kết luận “exploratory”, không tự đặt ngưỡng sau khi xem kết quả.

## 7. Kiểm soát thiên lệch

- Không chỉ PoC ứng viên được ưa thích trước.
- Dùng cùng use case, thiết bị, mạng, thời lượng và kịch bản cho các finalist.
- Ghi version SDK/server/browser và ngày test.
- Tách tính năng “documented” khỏi “verified”.
- Báo cáo cả test fail và limitation.
- Không dùng giá free tier để ngoại suy production khi chưa có workload.
- Không dùng demo hai tab cùng máy để suy ra khả năng đa chi nhánh/remote.
- Không suy ra recording an toàn chỉ vì vendor có nút Record; phải kiểm tra auth, storage, retention và audit.

## 8. Nguồn chính

- ISO/IEC 25010:2023: https://www.iso.org/standard/78176.html
- ISO/IEC 25040:2024: https://www.iso.org/standard/83467.html
- ISO/IEC 25023:2016: https://www.iso.org/standard/35747.html
- ISO/IEC 25020:2019: https://www.iso.org/standard/72117.html
- RFC 8825 WebRTC Overview: https://www.rfc-editor.org/rfc/rfc8825.html
- RFC 8445 ICE: https://www.rfc-editor.org/info/rfc8445/
- RFC 8656 TURN: https://www.rfc-editor.org/rfc/rfc8656.html
- RFC 8827 WebRTC Security Architecture: https://www.rfc-editor.org/info/rfc8827/
- W3C WebRTC API: https://www.w3.org/TR/webrtc/
- W3C WebRTC Statistics: https://www.w3.org/TR/webrtc-stats/
