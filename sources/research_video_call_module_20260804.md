# STATUS: SUPERSEDED / HISTORICAL RAW RESEARCH

Tài liệu này ghi lại giai đoạn nghiên cứu ban đầu. Các recommendation,
scoring method và PoC scope bên dưới đã bị thay thế sau khi scope được xác
nhận là direct video call 1:1 giữa hai nhân viên cùng truy cập web.

Canonical scope:

- [TASK-002-research-web-video-call.md](../internship-log/docs/06-tasks/TASK-002-research-web-video-call.md)
- [PROJECT1_INTERNAL_VIDEO_CALL_MODULE.md](../PROJECT1_INTERNAL_VIDEO_CALL_MODULE.md)

Canonical methodology:

- [research-protocol.md](../internship-log/work/TASK-002-web-video-call/docs/research-protocol.md)
- [candidate-spike-plan.md](../internship-log/work/TASK-002-web-video-call/docs/candidate-spike-plan.md)
- [evidence-table.md](../internship-log/work/TASK-002-web-video-call/references/evidence-table.md)

Không sử dụng recommendation trong file này để ra quyết định hiện tại.

# Research memo: Khảo sát thực tế cách nghiên cứu video call module trên web

- Ngày khảo sát: 2026-08-04
- Mục tiêu: Xác định các nhóm vấn đề mà tài liệu kỹ thuật và sample thực tế nghiên cứu trước khi chọn giải pháp video call; từ đó giới hạn đúng Project 1.
- Phương pháp: Đối chiếu tài liệu WebRTC/MDN và tài liệu, quickstart, production guide của LiveKit, Jitsi, Twilio và Daily. Ưu tiên nguồn chính thức; bài build-vs-buy của nhà cung cấp chỉ dùng để nhận diện tiêu chí, không dùng làm kết luận trung lập về nhà cung cấp.
- Lưu ý công cụ: backend chuyên dụng `research-lookup` không chạy được do máy chưa có `parallel-cli`, `PARALLEL_API_KEY` hoặc `OPENROUTER_API_KEY`; khảo sát dùng web research tích hợp và lưu nguồn tại đây.

## 1. Kết luận chính

Các nguồn thực tế không nghiên cứu video call như một API đơn lẻ. Nội dung thường được chia thành sáu lớp:

1. Use case và Quality of Experience (QoE): 1:1 hay nhóm, desktop/mobile, grid/presentation, độ trễ và chất lượng người dùng cần.
2. Cơ chế WebRTC: media capture, peer connection, signaling, SDP, ICE, STUN/TURN, P2P/SFU.
3. Hình thức tích hợp: iframe/prebuilt, SDK có custom UI, self-host OSS hoặc raw WebRTC.
4. Application integration: frontend client, backend phát token, room/participant/track, auth và webhook.
5. Production readiness: HTTPS, firewall/VPN, TURN fallback, browser/device matrix, reconnect, network quality, logs và diagnostics.
6. Bằng chứng PoC: hai client thật, backend token, cùng room, media hai chiều, controls, test khác mạng và ghi lại kết quả.

Do đó, câu hỏi hiệu quả không phải chỉ là “dùng LiveKit hay Jitsi?”, mà là:

> Với use case của hệ thống hiện tại, mức custom UI, quyền kiểm soát dữ liệu, effort vận hành và chất lượng mạng dự kiến, loại giải pháp nào phù hợp; PoC có chứng minh được các giả định quan trọng nhất không?

## 2. Người ta bắt đầu từ use case, không bắt đầu từ SDK

Twilio đặt câu hỏi đầu tiên của tài liệu chất lượng là người dùng cần và kỳ vọng gì; sau đó mới chọn cấu hình theo desktop/mobile và kiểu trải nghiệm grid, collaboration hoặc presentation. Daily cũng hướng dẫn chọn room settings theo số camera, thiết bị cũ/mobile và layout. Điều này cho thấy phần nghiên cứu đầu tiên phải là ma trận use case.

Tối thiểu cần xác định:

| Câu hỏi | Tác động kỹ thuật |
|---|---|
| 1:1 hay group? | P2P/SFU, downstream, layout, simulcast |
| Direct call hay meeting room? | Ringing/accept/reject thuộc app hay chỉ join room |
| Desktop hay mobile browser? | Permission, autoplay, backgrounding, device switching |
| Custom UI đến mức nào? | Iframe/prebuilt hay programmable SDK |
| Có recording không? | Egress/storage/consent/cost |
| Có dữ liệu nhạy cảm không? | Token, region, compliance, E2EE/key distribution |
| Mạng công ty/VPN/firewall? | UDP, TURN/TLS, preflight test |
| Quy mô và thời lượng? | Participant-minutes, concurrency, cost, capacity |

Nguồn:

- Twilio — Developing High Quality Video Applications: https://www.twilio.com/docs/video/tutorials/developing-high-quality-video-applications
- Daily — Configuring room settings: https://docs.daily.co/guides/configurations-and-settings/setting-up-calls

## 3. Cơ chế tối thiểu cần nghiên cứu

WebRTC official mô tả flow chung gồm lấy media, tạo `RTCPeerConnection`, trao đổi SDP offer/answer và ICE candidates qua một signaling channel do ứng dụng tự chọn. STUN/TURN tham gia ICE; TURN relay media khi đường kết nối phù hợp hơn không dùng được. MDN xác nhận `getUserMedia()` cần secure context (HTTPS, ngoại trừ môi trường local được tin cậy).

Phạm vi cơ chế vừa đủ cho một báo cáo giải pháp:

- `getUserMedia()` và permission camera/microphone.
- Local/remote `MediaStreamTrack`.
- `RTCPeerConnection`.
- SDP offer/answer.
- ICE candidates và trickle ICE.
- Signaling không nằm trong WebRTC specification.
- STUN để khám phá connectivity candidates.
- TURN làm relay/fallback.
- P2P, SFU và lý do group call thường dùng SFU.
- HTTPS/WSS, codec negotiation và browser differences.
- `getStats()` để lấy connection metrics.

Không cần tự triển khai đầy đủ signaling/TURN/SFU nếu mục tiêu là khảo sát giải pháp tích hợp.

Nguồn:

- WebRTC — Getting started with peer connections: https://webrtc.org/getting-started/peer-connections
- WebRTC — Advanced peer connection flow: https://webrtc.org/getting-started/peer-connections-advanced
- MDN — WebRTC API: https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API
- MDN — `getUserMedia()`: https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
- MDN — `RTCPeerConnection.getStats()`: https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/getStats

## 4. Bốn hướng giải pháp thực tế

### 4.1 Embed/prebuilt

Ví dụ: Jitsi IFrame API, Daily Prebuilt.

- Tốc độ demo và tích hợp cao nhất.
- Nhà cung cấp cung cấp phần lớn giao diện meeting.
- Có event/method để host app điều khiển một phần trải nghiệm.
- Hợp khi business cần “một phòng họp trong web”.
- Cần kiểm chứng giới hạn branding, layout, auth, meeting lifecycle và mức cô lập iframe.

Nguồn:

- Jitsi IFrame API: https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe/
- Daily documentation overview: https://docs.daily.co/
- Daily Prebuilt customization: https://docs.daily.co/guides/products/prebuilt/customizing-daily-prebuilt

### 4.2 Programmable SDK/managed media

Ví dụ: LiveKit Cloud, Twilio Video, Daily call object.

- Host app tự xây UI và business flow.
- Provider quản lý signaling/media infrastructure/SFU/TURN.
- Kiến trúc mẫu luôn có frontend client và backend phát access token.
- Hợp khi video là một capability nằm trong sản phẩm hiện hữu.
- Cần đánh giá SDK fit với framework, token/permission model, event model, webhook, diagnostics, cost và lock-in.

Nguồn:

- Twilio Video technical overview: https://www.twilio.com/docs/video/overview
- Twilio JavaScript quickstart: https://www.twilio.com/docs/video/javascript-getting-started
- LiveKit authentication: https://docs.livekit.io/home/concepts/authentication/
- LiveKit tokens and grants: https://docs.livekit.io/home/server/generating-tokens
- Daily call client: https://docs.daily.co/reference/daily-js/daily-call-client

### 4.3 Self-host open source

Ví dụ: LiveKit OSS, Jitsi.

- Có quyền kiểm soát hạ tầng, data placement và cấu hình.
- Đổi lại phải vận hành domain, certificate, load balancer, UDP/TCP/TURN ports, monitoring, scaling và upgrades.
- LiveKit production guide nói rõ WebRTC server khó deploy vì UDP ports và public IP; self-host còn phải cân nhắc TURN/TLS và firewall.
- Jitsi self-host gồm nhiều component như Videobridge, jicofo, Prosody và Jibri cho recording/streaming.

Nguồn:

- LiveKit self-hosting overview: https://docs.livekit.io/transport/self-hosting/
- LiveKit deployment: https://docs.livekit.io/transport/self-hosting/deployment/
- LiveKit ports/firewall: https://docs.livekit.io/transport/self-hosting/ports-firewall/
- Jitsi architecture: https://jitsi.github.io/handbook/docs/architecture/

### 4.4 Raw WebRTC

- Phù hợp để học cơ chế hoặc chứng minh 1:1 nhỏ.
- Application phải sở hữu signaling và TURN deployment/credentials; production còn có reconnect, browser quirks, quality adaptation, observability và testing.
- Google WebRTC codelab hữu ích để học API nhưng chính codelab cũng cảnh báo code codelab không mặc nhiên là lựa chọn production.

Nguồn:

- Google WebRTC codelab: https://developers.google.com/codelabs/webrtc-web
- WebRTC samples: https://webrtc.github.io/samples/

## 5. Những phần production mà research sơ sài thường bỏ sót

### 5.1 Authentication và token

LiveKit và Twilio đều yêu cầu backend phát token. Token chứa identity, room và permission; API secret không được nằm trong frontend. LiveKit phân biệt rõ development token server với production token endpoint.

### 5.2 Network và firewall

Twilio và LiveKit đều có tài liệu riêng về WSS, UDP, TURN/TLS, VPN và firewall. Việc demo chạy trên hai tab cùng máy chưa chứng minh hoạt động trên mạng công ty hoặc hai mạng khác nhau.

### 5.3 Pre-call diagnostics

Twilio Preflight API kiểm tra signaling, TURN, peer connection và synthetic media trước khi user vào room; report có jitter, RTT, packet loss và selected ICE candidates. Đây là bằng chứng rằng production research cần có connectivity/diagnostic plan, không chỉ happy path.

### 5.4 Browser/device matrix

Twilio công bố riêng browser support và các caveat như Safari constraints, iOS WebView và mobile backgrounding. Cần chốt browser target rồi test trên target đó, không ghi chung “browser hỗ trợ WebRTC”.

### 5.5 Quality và observability

Twilio có Network Quality API; WebRTC chuẩn có `getStats()`. Các metric có ý nghĩa gồm RTT, jitter, packet loss, bitrate, selected candidate pair, time-to-connect và unexpected disconnect.

### 5.6 Webhooks và lifecycle

Provider room lifecycle không đồng nghĩa business call lifecycle. LiveKit webhook đưa các event như room started/finished, participant joined/left và connection aborted; hệ thống vẫn phải quyết định mapping vào nghiệp vụ nếu sau này làm module thật.

### 5.7 E2EE

LiveKit hỗ trợ E2EE nhưng ứng dụng phải tự tạo, phân phối và xoay khóa. Vì server không có key, E2EE ảnh hưởng trực tiếp tới recording, transcription hoặc server-side media processing. Không nên chỉ đánh dấu một ô “có E2EE” mà bỏ qua key management.

Nguồn:

- Twilio Preflight API: https://www.twilio.com/docs/video/troubleshooting/preflight-api
- Twilio Network Quality API: https://www.twilio.com/docs/video/using-network-quality-api
- Twilio firewall/network configuration: https://www.twilio.com/docs/video/ip-addresses
- Twilio browser support: https://www.twilio.com/docs/video/javascript
- LiveKit webhooks: https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/
- LiveKit encryption overview: https://docs.livekit.io/transport/encryption/

## 6. Cách người ta làm demo/quickstart

Quickstart của Twilio và sample LiveKit đều dùng pattern:

1. Tạo account/project và credentials.
2. Đặt secret ở backend/environment.
3. Backend phát token.
4. Frontend nhập hoặc nhận room name.
5. Browser xin camera/microphone.
6. Client join room.
7. Mở tab/browser thứ hai, join cùng room.
8. Quan sát local/remote media và participant events.

PoC hiệu quả cho Project 1 nên bổ sung hai phép thử mà quickstart cơ bản thường chưa chứng minh:

- Hai thiết bị ở hai mạng khác nhau, ví dụ Wi-Fi và hotspot.
- Permission denied hoặc network interruption/reconnect.

Evidence cần lưu:

- Source code và README.
- Cấu hình môi trường mẫu không chứa secret.
- Video quay demo hoặc URL deploy.
- Test matrix pass/fail.
- Thời gian join và loại connection nếu SDK expose được.
- Known limitations.

Nguồn:

- Twilio JavaScript quickstart: https://www.twilio.com/docs/video/javascript-getting-started
- Twilio two-browser tutorial: https://www.twilio.com/docs/video/tutorials/get-started-with-twilio-video-python-flask-frontend
- LiveKit Meet sample: https://github.com/livekit-examples/meet
- Daily demos: https://docs.daily.co/guides/additional-resources/demos

## 7. Ma trận khảo sát giải pháp nên dùng

SUPERSEDED: Bản nghiên cứu ban đầu từng đề xuất dùng thang điểm số sau spike nhỏ.
Method hiện hành đã thay thế cách này bằng evidence code S/V/T/C/U, predefined
test matrix và decision record có điều kiện.

| Nhóm | Tiêu chí cần đo/kiểm chứng |
|---|---|
| Product fit | 1:1/group, direct call/meeting, custom UI, screen share, recording |
| Integration | Vue 2/plain JS fit, .NET token support, API/webhook, bundle impact |
| Security | Backend token, room permissions, webhook verification, region/E2EE |
| Quality | Join time, reconnect, adaptive quality, network indicator, diagnostics |
| Compatibility | Chrome/Edge/Safari/mobile theo target thực tế |
| Operations | Cloud/self-host, firewall/TURN, logs, dashboards, SLA/support |
| Economics | Participant-minutes, recording/storage, free tier, infra/SRE cost |
| Portability | Provider abstraction khả thi đến đâu, mức SDK type leak vào UI |
| Developer experience | Time-to-first-call, docs, sample, lỗi gặp trong PoC |

Twilio và Daily đều công bố mô hình tính phí theo participant-minute; recording/storage có cách tính riêng. Vì vậy báo cáo chỉ nên so sánh chi phí sau khi có giả định số participant, phút/call và số call/tháng, không dùng nhãn chung “rẻ/đắt”.

Nguồn giá tham khảo tại ngày khảo sát:

- Twilio Video pricing: https://www.twilio.com/en-us/video/pricing
- Daily Video pricing: https://www.daily.co/pricing/video-sdk/

## 8. Scope Project 1 bám sát yêu cầu sếp

Yêu cầu gốc: “Nghiên cứu cơ chế gọi video qua web. Xem giải pháp trước. Có demo càng tốt.”

Sau khi đối chiếu nguồn thực tế, scope phù hợp là một solution study + technical spike, không phải xây module production hoàn chỉnh.

### Research questions

1. Video call trong browser thiết lập kết nối và truyền media như thế nào?
2. Khi nào P2P đủ, khi nào cần SFU/TURN?
3. Có những kiểu tích hợp nào: embed, SDK, self-host, raw?
4. Giải pháp nào phù hợp nhất nếu sau này đóng thành module ghép vào Vue 2 + .NET?
5. Mỗi giải pháp đòi hỏi backend, token, network và vận hành gì?
6. Những rủi ro nào phải chứng minh qua PoC thay vì chỉ đọc docs?

### Shortlist thực dụng

- LiveKit: đại diện programmable SDK có custom UI và lựa chọn Cloud/self-host.
- Jitsi: đại diện iframe/prebuilt/self-host meeting platform.
- Twilio Video hoặc Daily: đại diện managed programmable/prebuilt provider để có đối chứng commercial.
- Raw WebRTC: baseline để hiểu phần provider đang xử lý, không mặc định là production candidate.

### PoC được đề xuất

SUPERSEDED: Bản nghiên cứu ban đầu từng đề xuất bắt đầu bằng LiveKit Cloud để
kiểm chứng module custom. Recommendation hiện hành không ưu tiên vendor trước;
candidate phải đi qua desk screening, feasibility spike và gate qualification.

PoC tối thiểu:

- Một backend endpoint phát token; secret chỉ ở backend.
- Một Vue 2 page/component nhận `roomId`.
- Local preview và remote video/audio.
- Join, mute, camera off, leave.
- Hai browser cùng room.
- Log connection/reconnect/error states.
- Test hai network và permission denied.

Scope PoC cũ từng loại trừ:

- Incoming ringing/accept/reject.
- Database và call history.
- Recording, E2EE, group-call UX.
- Production self-host.
- Provider abstraction hoàn chỉnh.

Các phần trên được ghi vào “next phase nếu solution được duyệt”, không biến thành deliverable bắt buộc của task nghiên cứu.

## 9. Deliverables nên nộp

1. Báo cáo 5–8 trang hoặc Markdown tương đương:
   - Executive summary.
   - WebRTC mechanism.
   - Bốn hướng giải pháp.
   - Evaluation matrix.
   - PoC findings.
   - Recommendation có điều kiện và next steps.
2. Source PoC + README.
3. Video demo 2–3 phút hoặc URL chạy thử.
4. Test matrix và known limitations.
5. Một trang decision record: vì sao chọn giải pháp PoC và điều gì còn phải xác nhận trước production.

## 10. Kết luận áp dụng

Hướng “một module ghép vào hệ thống có sẵn” là tiêu chí product fit đúng và nên chi phối cách chọn solution. Tuy nhiên, task hiện tại chỉ nên chứng minh rằng một programmable SDK có thể được bọc thành frontend component + backend token endpoint trong stack hiện tại. Thiết kế đầy đủ call lifecycle, database, incoming notification và production operations là phase kế tiếp sau khi sếp duyệt kết quả solution study.
