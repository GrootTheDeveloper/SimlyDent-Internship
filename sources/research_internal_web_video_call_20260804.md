# RAW RESEARCH SNAPSHOT — KHÔNG PHẢI DECISION RECORD

# Research memo sơ bộ — video call 1:1 giữa nhân viên trên web

> Lưu ý phương pháp: memo này ghi nhận khả năng được công bố trong tài liệu nhà cung cấp, không phải bảng xếp hạng và không đủ để chọn giải pháp. Scope/protocol hiện hành nằm tại [TASK-002](../internship-log/docs/06-tasks/TASK-002-research-web-video-call.md). Quy trình đánh giá chuẩn hóa được bổ sung tại `research_method_video_solution_evaluation_20260804.md`.

- Ngày đối chiếu: 2026-08-04
- Scope: Hai nhân viên đã đăng nhập cùng hệ thống web; người A gọi trực tiếp người B; B nhận màn hình đổ chuông trên web, chấp nhận/từ chối; sau khi chấp nhận, hai browser truyền audio/video. Recording là optional R-06.
- Phương pháp: Ưu tiên tài liệu chính thức của WebRTC/MDN, Stringee, LiveKit và Jitsi; đối chiếu khả năng direct-call, media, token, recording và mức tích hợp.
- Lưu ý công cụ: backend `research-lookup` chuyên dụng chưa chạy được vì môi trường không có `parallel-cli`/API key; kết quả được kiểm chứng bằng web research tích hợp và lưu tại file này.

## Kết luận

1. Đây là browser-to-browser/app-to-app video call, không có PSTN, SIM, số điện thoại hoặc Voice Brandname.
2. WebRTC chỉ giải quyết media. Một direct call hoàn chỉnh còn cần định danh user, online presence, call invitation, ringing, accept/reject/busy/timeout, authorization, token, call log, webhook và recording.
3. Trong desk evidence đã thu, Stringee Call API công bố direct-call primitives gần use case: Web SDK hỗ trợ app-to-app voice/video, `makeCall`, `incomingcall`, `answer`, `reject`, media events, backend `answer_url`, `event_url`, JWT và record/store calls. Đây là bằng chứng V, chưa phải kết luận chọn Stringee.
4. LiveKit phù hợp nếu ưu tiên custom UI, khả năng Cloud/self-host và kiểm soát media. Tuy nhiên LiveKit dùng mô hình room; ứng dụng phải tự xây lớp call invitation/ringing/presence. Recording dùng Egress và token phải được backend ký, giới hạn theo room/permission.
5. Jitsi IFrame là cách nhúng meeting nhanh nhưng meeting-first, ít khớp hơn với direct call theo user và custom lifecycle. Recording/self-host tạo thêm phụ thuộc vận hành.
6. Raw WebRTC phù hợp để học cơ chế, không phải lựa chọn PoC nghiệp vụ đầu tiên vì phải tự làm signaling, TURN, reconnect, diagnostics và recording.

## Cơ chế minh họa nếu chạy Stringee feasibility spike

1. Backend ánh xạ mỗi nhân viên SimlyDent với một Stringee user ID và cấp token ngắn hạn.
2. Khi đăng nhập, browser kết nối StringeeClient.
3. A chọn B và tạo video call app-to-app.
4. Stringee gọi `answer_url`; backend kiểm tra tenant, quyền, người gọi/người nhận và trả call-control instruction.
5. Browser B nhận `incomingcall`, hiển thị incoming-call modal và cho phép answer/reject.
6. Khi B chấp nhận, hai browser nhận local/remote media stream.
7. `event_url`/SDK events cập nhật call lifecycle. Nếu recording được phép, backend bật recording theo policy và lưu recording ID thay vì public URL.

## Nguồn chính thức

- Stringee Web SDK app-to-app/video/incoming/answer/reject: https://developer.stringee.com/docs/getting-started-stringee-web-sdk
- Stringee Call API overview, JWT, answer/event URL, record/store calls: https://developer.stringee.com/docs/call-api-overview
- Stringee JavaScript SDK reference: https://developer.stringee.com/docs/web-api-reference
- WebRTC peer connections: https://webrtc.org/getting-started/peer-connections
- MDN getUserMedia/secure context: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- LiveKit tokens and room grants: https://docs.livekit.io/home/server/generating-tokens
- LiveKit recording/Egress: https://docs.livekit.io/home/egress/overview/
- LiveKit RoomComposite recording: https://docs.livekit.io/home/egress/web/
- Jitsi IFrame API: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe/
- Jitsi recording command: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe-commands/

## Bổ sung: khả năng tự phát triển hoặc dùng open source

Có thể triển khai mà không trả phí theo phút cho Stringee:

1. **Raw WebRTC 1:1:** browser truyền media P2P; backend hiện có dùng WebSocket/SignalR làm signaling; tự host coturn để relay khi P2P không đi được. coturn là phần mềm STUN/TURN mã nguồn mở miễn phí. Chi phí còn lại là VM, IP/domain/TLS, băng thông TURN, lưu trữ và vận hành.
2. **LiveKit self-host:** media server LiveKit là open source Apache 2.0 và có thể tự host; direct-call invitation/ringing vẫn do ứng dụng tự xây. Recording cần triển khai thêm LiveKit Egress và storage.
3. **Jitsi self-host:** không có phí license nền tảng, nhưng thiên về meeting UI. Server-side recording cần Jibri; tài liệu Docker mô tả Jibri như một thành phần bổ sung riêng.

Với 1:1 và mục tiêu demo, raw WebRTC + signaling là khả thi. Với production có recording, LiveKit self-host là baseline open-source đáng đánh giá hơn vì đã có media server và Egress. “Open source/free license” không đồng nghĩa “không có chi phí”: TURN/video recording tiêu thụ nhiều bandwidth/CPU/storage và cần giám sát, bảo mật, nâng cấp.

Nguồn bổ sung:

- coturn repository: https://github.com/coturn/coturn
- LiveKit repository/license: https://github.com/livekit/livekit
- LiveKit self-host/open-source statement: https://livekit.com/pricing
- LiveKit Egress: https://docs.livekit.io/transport/media/ingress-egress
- Jitsi self-hosting: https://jitsi.github.io/handbook/docs/devops-guide/
- Jitsi Docker/Jibri recording: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/
