# Candidate Spike Plan - TASK-002

- Phiên bản: 2026-08-05
- Mục tiêu: giải quyết các `U` có thể thay đổi quyết định; không xây sản phẩm hoàn chỉnh.

## Entry conditions

- Có Linux host/VM với public IP, domain và TLS hợp lệ.
- Có quyền mở media ports UDP/TCP và triển khai TURN.
- Khóa browser/device/network matrix, timeout và số lần lặp.
- Có bốn test identities A1/A2/A3 cùng tenant và B1 khác tenant.
- Không commit API secret, TURN long-term credential hoặc token còn hạn.

## Phase 0 - environment baseline

| Work item | Output | Pass condition |
|---|---|---|
| Deploy coturn | Versioned config + redacted runbook | Trickle ICE tạo relay candidate |
| Network probes | UDP/TCP/TLS reachability log | Các port dự kiến truy cập được từ hai mạng |
| Browser stats collector | JSON schema + sample | Lưu được candidate type, RTT, jitter, packet loss, bitrate |
| Backend call state skeleton | PostgreSQL schema + atomic transitions | Cross-tenant create bị từ chối; accept/cancel idempotent |

## Phase 1 - LiveKit self-host preferred spike

**Trạng thái 2026-08-05:** Local implementation hoàn tất tại `../poc/livekit-1to1/`. Build và 17/17 kiểm tra application/security PASS. HTTPS API, SignalR và LiveKit signaling WSS qua Quick Tunnel PASS. Responsive viewport 360x800 và 390x844 PASS. Recording Egress 720p PASS bằng video mẫu. Chất lượng A/V sau tối ưu trên thiết bị thật, khác mạng, forced TURN và reconnect chưa chạy; toàn bộ exit criteria chưa đạt.

### Câu hỏi quyết định

- Vue 2 có thể dùng `livekit-client` trực tiếp mà không cần React components không?
- Backend .NET có thể phát JWT grants và gọi Room Service/Twirp an toàn mà không phụ thuộc SDK .NET bỏ hoang không?
- Invitation/presence/state đặt ngoài LiveKit room cần bao nhiêu authoritative code?
- Có thu được forced relay/selected candidate evidence trong client path dự kiến không?
- Single-node deployment cần những port, Redis, metrics và restart behavior nào?

### Minimal implementation

1. Backend tạo `CallSession` và gửi invitation qua SignalR/WebSocket.
2. Chỉ sau atomic accept mới phát LiveKit token ngắn hạn, scope đúng room/identity/publish/subscribe.
3. Hai browser join room, publish camera/microphone và subscribe peer.
4. Reconcile LiveKit participant/webhook events với application call state.
5. Chạy happy path, reject, cancel/accept race, busy, no-answer, cross-tenant, multi-tab, reconnect và mobile callee.
6. Chạy forced TURN/relay case và lưu raw stats.

### Exit criteria

- Không join media trước accept.
- Token sai tenant/room bị từ chối.
- Chỉ một accept thắng trong multi-tab/race.
- Audio/video hai chiều và terminal state nhất quán.
- Có bằng chứng relay candidate, không chỉ screenshot cuộc gọi thành công.
- Có deploy/runbook và resource snapshot.

## Phase 2 - mediasoup differential spike

Chỉ chạy nếu LiveKit còn rủi ro hoặc giới hạn ở một trong các điểm: custom transport/media behavior, observability, dependency/API portability hoặc .NET integration.

### Minimal implementation

- Media sidecar Node.js hoặc Rust sở hữu mediasoup worker/router/transport.
- Backend .NET vẫn là authority cho call session và authorization.
- Adapter nội bộ chuyển lệnh create transport/connect/produce/consume.
- Chỉ implement happy path + forced TURN + one negative authorization case; tái dùng state skeleton.

### Exit criteria

- Đo được số service/API/state bổ sung so với LiveKit.
- Chứng minh lợi thế kỹ thuật cụ thể, không chỉ “customizable hơn”.
- Có failure isolation và restart behavior tối thiểu của worker/media sidecar.

Nếu không tạo lợi thế quyết định rõ, dừng mediasoup để tránh tự xây communication platform.

## Phase 3 - Raw WebRTC + coturn baseline

Baseline này đo minimum 1:1 P2P và NAT traversal, không phải mặc định đề xuất production.

- Dùng SignalR/WebSocket chuyển SDP/ICE và call-control messages.
- Backend authority cho invitation/state; browser quản lý `RTCPeerConnection`.
- Chạy direct path và `iceTransportPolicy: relay` với coturn.
- Ghi code surface cần tự xử lý: glare, renegotiation, reconnect, device switch, stats, relay credentials và browser quirks.

## Conditional Janus spike

Chỉ bắt đầu khi legal chấp nhận GPL-3.0 và team muốn đánh giá VideoCall plugin.

- Không dùng fake registration demo làm production identity.
- Backend phải map user/tenant sang Janus session/plugin handle.
- Chạy happy path, negative tenant, forced relay và gateway restart.

## Candidate không spike trong phase hiện tại

- Jitsi, OpenVidu, Element Call, MiroTalk, Nextcloud Talk, Pion và Stringee.
- Chỉ mở lại khi stakeholder thay đổi hard requirement hoặc candidate ưu tiên thất bại vì lý do đã ghi nhận.

## Artifacts bắt buộc cho mỗi run

- Commit hash và image/package versions.
- Sanitized deployment config.
- Browser/OS/device/network metadata.
- Backend transition log và media/server events.
- Raw WebRTC stats JSON.
- Video hoặc screenshot chỉ là phụ trợ, không thay raw evidence.
- CPU/RAM/network snapshot.
- Result: Pass / Fail / Inconclusive kèm lý do.

## Stop rule

Dừng candidate ngay khi có hard-gate failure không thể khắc phục trong scope, security isolation failure mang tính kiến trúc, hoặc license không được chấp nhận. Không tiếp tục comparative PoC chỉ để có đủ số cột so sánh.
