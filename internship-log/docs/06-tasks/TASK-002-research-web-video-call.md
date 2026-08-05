# TASK-002: Nghiên cứu giải pháp open-source cho video call 1:1 trên web

## Metadata

- Trạng thái: In Progress - PoC đã chạy trên laptop và iPhone; kiểm chứng production chưa hoàn tất
- Ngày nhận: 2026-08-04
- Ngày chuẩn hóa lại scope: 2026-08-05
- Loại task: Research / Solution study / Technical PoC
- Người giao: Sếp/mentor
- Team: Kỹ thuật
- Hạn hoàn thành: Chưa xác nhận
- Repository triển khai: Chưa xác định
- Branch / Pull request: Chưa áp dụng
- Báo cáo chính: [bao-cao-nghien-cuu-video-call.md](../../work/TASK-002-web-video-call/docs/bao-cao-nghien-cuu-video-call.md)
- Workspace: [work/TASK-002-web-video-call](../../work/TASK-002-web-video-call/README.md)

## Yêu cầu đã chuẩn hóa

Nghiên cứu và đề xuất giải pháp **open-source, self-hostable** để xây module video call 1:1 trên web, có khả năng tùy biến sâu và hạn chế phụ thuộc dịch vụ bên thứ ba.

Trong tài liệu này:

- `open-source` nghĩa là thành phần cốt lõi có mã nguồn và license được công bố; license vẫn phải qua legal review.
- `self-hostable` nghĩa là production không bắt buộc gửi signaling hoặc media qua dịch vụ SaaS của nhà cung cấp.
- `hạn chế phụ thuộc bên thứ ba` nghĩa là không có dependency runtime bắt buộc vào hosted service bên ngoài. OSS library, hệ điều hành, hạ tầng IaaS và CDN do doanh nghiệp chủ động chọn không bị coi là vendor runtime lock-in.
- STUN/TURN production phải do doanh nghiệp tự vận hành hoặc được phê duyệt riêng; không dựa vào public TURN miễn phí.

## Phạm vi chức năng

### Core

- Video call 1:1 giữa hai nhân viên đã đăng nhập.
- Caller chọn callee theo user của hệ thống, không phải nhập meeting URL.
- Incoming call, accept, reject, cancel, busy, no-answer và hangup.
- Desktop web và mobile web; ưu tiên Chrome/Edge, kiểm tra Safari/iOS bằng thiết bị thật.
- Hoạt động qua NAT/firewall với STUN/TURN và có thể chứng minh relay path.
- Tích hợp identity, authorization, tenant isolation, call log và realtime channel của SimlyDent.
- UI/UX cuộc gọi do SimlyDent kiểm soát; không bắt buộc dùng meeting UI có sẵn.

### Optional, không dùng để loại candidate ở vòng core

- Recording.
- Screen sharing.
- Group call.
- Push notification khi trình duyệt bị background/đóng.
- E2EE ở tầng ứng dụng.

## Candidate universe

Khảo sát rộng ngày 2026-08-05 gồm:

1. LiveKit.
2. mediasoup.
3. Janus WebRTC Server.
4. Jitsi Meet.
5. OpenVidu Community.
6. Raw WebRTC + application signaling + coturn.
7. Element Call / MatrixRTC.
8. MiroTalk SFU.
9. Nextcloud Talk.
10. Pion WebRTC như building block, không phải module hoàn chỉnh.

Managed-only API như Stringee không thuộc candidate set chính vì không vượt hard gate self-host. Chỉ được nhắc trong lịch sử nghiên cứu, không đưa vào shortlist hoặc PoC.

## Hard gates

- [x] Có source repository và license công khai cho thành phần cốt lõi.
- [x] Có thể self-host signaling/media path mà không bắt buộc dùng SaaS.
- [x] Có WebRTC web client hoặc giao thức/API đủ để xây web client.
- [x] Cho phép sở hữu UI và call lifecycle ở tầng ứng dụng.
- [ ] Legal xác nhận license và nghĩa vụ phân phối/network use.
- [ ] PoC chứng minh video 1:1, incoming/accept/reject/cancel/busy/no-answer. Đã kiểm tra luồng gọi, quyền, hai thiết bị cùng phòng và phát media; chưa nghiệm thu A/V hai chiều và no-answer.
- [ ] PoC chứng minh desktop/mobile browser matrix. Đã kiểm tra laptop và iPhone thật; Android và ma trận trình duyệt đầy đủ chưa kiểm tra.
- [ ] PoC chứng minh forced TURN hoặc selected relay candidate.
- [x] PoC kiểm tra tenant isolation, token scoping, recording gate, duplicate transition và busy reservation bằng smoke test 17/17.
- [ ] Có runbook triển khai, observability và ước lượng vận hành.

## Kết quả desk research hiện tại

### Shortlist để spike

1. **LiveKit self-host - candidate ưu tiên.** Cân bằng tốt giữa programmable SDK/SFU, khả năng tự host, license permissive và mức effort tích hợp.
2. **mediasoup - candidate đối chứng về tùy biến sâu.** Low-level và signaling-agnostic, nhưng cần media service Node.js hoặc Rust riêng và phải tự xây nhiều lớp hơn.
3. **Raw WebRTC + SignalR/WebSocket + coturn - architecture baseline.** Kiểm soát cao nhất cho 1:1 P2P, đồng thời là mốc đo phần engineering mà platform giúp tiết kiệm.

### Conditional candidate

- **Janus:** có VideoCall plugin 1:1 và kiến trúc plugin linh hoạt; chỉ spike nếu GPL-3.0 được legal chấp nhận và team muốn đánh đổi SDK cấp cao lấy gateway control.

### Screened out khỏi comparative PoC hiện tại

- **Jitsi Meet:** self-host tốt nhưng meeting-centric; custom sâu thường dẫn tới fork UI/stack lớn.
- **OpenVidu Community:** tự host và API cấp cao, nhưng là lớp phân phối/fork trên stack LiveKit/mediasoup và có ranh giới Community/PRO; chưa tạo lợi thế rõ hơn LiveKit trực tiếp cho bài toán này.
- **Element Call:** kéo theo Matrix homeserver, MatrixRTC authorization service và LiveKit; không khớp hệ thống identity hiện tại.
- **MiroTalk SFU:** app hội nghị hoàn chỉnh, AGPL-3.0 và domain/UI riêng; phù hợp deploy sản phẩm có sẵn hơn là module custom.
- **Nextcloud Talk:** gắn chặt hệ sinh thái Nextcloud và AGPL-3.0; không phù hợp làm media module độc lập.
- **Pion:** thư viện WebRTC cấp thấp; dùng để tự xây server hoặc tham khảo, không giảm đủ application/media engineering.

## Tiêu chí hoàn thành

- [x] Scope open-source/self-hostable được diễn giải thành hard gates.
- [x] Có inventory các dự án đang hoạt động và nguồn chính thức truy vết được.
- [x] Có screening rationale và shortlist không chứa managed-only vendor.
- [x] Có báo cáo kỹ thuật, evidence table và source log đồng bộ.
- [x] Có kế hoạch spike theo thứ tự, không PoC mọi candidate một cách máy móc.
- [x] Có source code spike, README chạy và cấu hình che secret; commit hash chưa áp dụng trong workspace hiện tại.
- [ ] Có raw result cho browser/mobile/network/forced TURN/security cases. Đã có browser desktop, SignalR, WSS và security state; mobile thiết bị thật, A/V và TURN chưa chạy.
- [ ] Có decision record cuối với effort, TCO, rủi ro license và điều kiện áp dụng.

## Quá trình thực hiện

### 2026-08-04

- Xác nhận core scope là direct video call web-to-web giữa hai nhân viên.
- Chuẩn hóa WebRTC fundamentals, call state machine, test identity và metric schema.
- Loại bỏ cách hiểu cũ Web-to-Phone/PSTN.

### 2026-08-05 - desk research ban đầu

- Viết báo cáo so sánh Stringee, LiveKit, Jitsi và Raw WebRTC.
- Chưa có feasibility spike hoặc demo thật.

### 2026-08-05 - chuẩn hóa theo yêu cầu open-source/self-hostable

- Loại Stringee khỏi candidate set chính vì không vượt hard gate self-host.
- Mở rộng khảo sát sang mediasoup, Janus, OpenVidu, Element Call, MiroTalk, Nextcloud Talk, Pion và coturn.
- Chốt shortlist spike: LiveKit, mediasoup và Raw WebRTC + coturn; Janus là conditional candidate.
- Đồng bộ lại report, source log, evidence table, research protocol và candidate spike plan.
- Lưu ý: mọi nhận định chất lượng production vẫn là `U` cho đến khi có test evidence.

### 2026-08-05 - LiveKit feasibility PoC

- Triển khai LiveKit Server 1.13.1, backend ASP.NET Core, SignalR và frontend Vue 2 bằng Docker Compose.
- Triển khai direct-call state gồm `Ringing`, `Accepted`, `Rejected`, `Cancelled` và `Ended`; áp dụng busy reservation và tenant isolation.
- Cấp LiveKit JWT sau `Accepted`, giới hạn theo room và identity, TTL 5 phút; secret không xuất hiện trong frontend.
- Smoke test application/security đạt 17/17 trên trạng thái sạch.
- Kiểm tra HTTPS/API/WSS qua Cloudflare Quick Tunnel; LiveKit signaling WebSocket kết nối và nhận frame đầu tiên.
- Kiểm tra responsive tại viewport 360x800 và 390x844; kiểm tra thêm trên iPhone thật.
- Laptop và iPhone đã vào cùng phòng LiveKit, cấp quyền và phát camera/microphone. Laptop đã nhận video dọc từ iPhone. Chưa có biên bản nghiệm thu A/V hai chiều sau bản sửa phía nhận.
- Đã triển khai danh sách người dùng, nút gọi, popup nhận cuộc gọi, chấp nhận/từ chối và màn hình `/call/{callId}` riêng.
- Đã bổ sung tự đăng ký luồng nhận, xử lý phát video trên iOS và hiển thị video dọc theo tỷ lệ gốc, không cắt khung hình.
- Đã đặt mục tiêu video 720p/30fps, yêu cầu lớp nhận HD và hiển thị WebRTC stats gồm độ phân giải, fps, bitrate, mất gói, độ trễ và nguyên nhân giới hạn.
- Đã triển khai Redis và LiveKit Egress. Kiểm thử end-to-end tạo MP4 H.264 1280x720, 30fps và AAC; start, stop, finalize, tải đúng quyền và chặn khác tenant đều đạt.
- Media hiện được kiểm tra trong cùng Wi-Fi/Mobile Hotspot. Khác mạng, TURN, reconnect và tải đồng thời chưa kiểm tra.

## Blocker và câu hỏi cần xác nhận

1. Hạn hoàn thành và hình thức bàn giao: báo cáo, slide hay demo trực tiếp?
2. Có cho phép chạy media service sidecar bằng Go/Node.js/Rust cạnh backend .NET không?
3. Hạ tầng PoC có public IP/domain/TLS và quyền mở UDP/TCP cho media/TURN không?
4. License copyleft như GPL-3.0/AGPL-3.0 có được legal chấp nhận không?
5. Chính sách đồng ý ghi hình, thời hạn lưu, mã hóa và audit áp dụng theo quy định nào?

## Trạng thái hiện tại

**Nghiên cứu hoàn tất; LiveKit PoC đã vượt kiểm tra trạng thái ứng dụng, tenant và token, đồng thời đã kết nối laptop với iPhone trong mạng thử nghiệm. LiveKit là phương án đề xuất, chưa phải quyết định production.** Quyết định production cần thêm kết quả A/V hai chiều, Android/iOS, khác mạng, TURN, reconnect, tải và vận hành.
