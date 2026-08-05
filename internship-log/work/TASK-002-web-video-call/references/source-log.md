# Source Log - TASK-002

- Research refresh: 2026-08-05
- Scope: open-source, self-hostable video call 1:1
- Rule: capability từ docs/repository chỉ là `P/R`; reliability và production fit vẫn cần `T`.

## Standards và nền tảng

| ID | Code | Claim được hỗ trợ | Nguồn | Truy cập |
|---|---|---|---|---|
| SRC-001 | S | WebRTC architecture tách browser APIs, signaling và media | [RFC 8825](https://www.rfc-editor.org/rfc/rfc8825.html) | 2026-08-05 |
| SRC-002 | S | ICE thực hiện connectivity checks/NAT traversal và dùng signaling ngoài băng | [RFC 8445](https://www.rfc-editor.org/rfc/rfc8445.html) | 2026-08-05 |
| SRC-003 | S | TURN cung cấp relay khi direct path không khả dụng | [RFC 8656](https://www.rfc-editor.org/rfc/rfc8656.html) | 2026-08-05 |
| SRC-004 | S | WebRTC security architecture và consent | [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html) | 2026-08-05 |
| SRC-005 | S | `getStats()` cung cấp WebRTC transport/media statistics | [W3C WebRTC Statistics](https://www.w3.org/TR/webrtc-stats/) | 2026-08-05 |
| SRC-006 | R | coturn là STUN/TURN server open-source, có Docker và nhiều backend credential/database | [coturn repository](https://github.com/coturn/coturn) | 2026-08-05 |
| SRC-007 | R | Pion là implementation WebRTC pure Go, MIT; là building block chứ không có direct-call application lifecycle | [Pion WebRTC repository](https://github.com/pion/webrtc) | 2026-08-05 |

## Candidate ưu tiên và conditional

| ID | Code | Claim được hỗ trợ | Nguồn | Truy cập |
|---|---|---|---|---|
| SRC-010 | R | LiveKit server Apache-2.0, SFU, JWT, UDP/TCP/TURN, Docker/Kubernetes và browser SDK | [LiveKit repository](https://github.com/livekit/livekit) | 2026-08-05 |
| SRC-011 | P | LiveKit cho phép self-host server trên VM/Kubernetes/multi-region và kiểm soát infrastructure/data/config | [LiveKit self-hosting overview](https://docs.livekit.io/transport/self-hosting/) | 2026-08-05 |
| SRC-012 | P | Token LiveKit mang room, identity và permission grants, được backend ký | [LiveKit tokens and grants](https://docs.livekit.io/home/server/generating-tokens) | 2026-08-05 |
| SRC-013 | P | Room Service có HTTP/Twirp API; có thể tự implement client khi ngôn ngữ thiếu official SDK | [LiveKit Room Service API](https://docs.livekit.io/reference/other/roomservice-api/) | 2026-08-05 |
| SRC-014 | P | Self-host recording cần deploy Egress service riêng và Redis | [LiveKit Egress self-hosting](https://docs.livekit.io/transport/self-hosting/egress/) | 2026-08-05 |
| SRC-015 | R | mediasoup ISC, SFU low-level, Node.js module hoặc Rust crate, signaling-agnostic | [mediasoup repository](https://github.com/versatica/mediasoup) | 2026-08-05 |
| SRC-016 | R | Janus là GPL-3.0 general-purpose WebRTC server, plugin/transport/event architecture và token auth | [Janus repository](https://github.com/meetecho/janus-gateway) | 2026-08-05 |
| SRC-017 | P | Janus VideoCall plugin relay media giữa đúng hai peer và có call-by-username demo semantics | [Janus VideoCall plugin](https://janus.conf.meetecho.com/docs/videocall) | 2026-08-05 |

## Candidate được screen nhưng không vào core PoC

| ID | Code | Claim được hỗ trợ | Nguồn | Truy cập |
|---|---|---|---|---|
| SRC-020 | R/P | Jitsi Meet Apache-2.0, self-hostable, có web/native SDK nhưng kiến trúc là conferencing stack gồm web, JVB, Jicofo, Prosody và optional Jibri | [Jitsi repository](https://github.com/jitsi/jitsi-meet), [Jitsi architecture](https://jitsi.github.io/handbook/docs/architecture/) | 2026-08-05 |
| SRC-021 | P | Jitsi IFrame có self-host endpoint, JWT, events/commands và config overwrite; integration vẫn xoay quanh meeting room | [Jitsi IFrame API](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe/) | 2026-08-05 |
| SRC-022 | P | Jitsi cung cấp Docker self-host stack và tách nhiều component vận hành | [Jitsi Docker guide](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/) | 2026-08-05 |
| SRC-023 | P | OpenVidu hiện là self-host platform/API tương thích LiveKit, Community single-node và PRO cho multi-node/HA | [OpenVidu current docs](https://openvidu.io/latest/docs/) | 2026-08-05 |
| SRC-024 | R | OpenVidu distribution repository công bố Apache-2.0 nhưng thêm một distribution layer trên LiveKit | [OpenVidu LiveKit repository](https://github.com/OpenVidu/openvidu-livekit) | 2026-08-05 |
| SRC-025 | R/P | Element Call AGPL-3.0 dùng MatrixRTC, Matrix homeserver, authorization service và LiveKit backend | [Element Call repository](https://github.com/element-hq/element-call), [self-hosting guide](https://github.com/element-hq/element-call/blob/livekit/docs/self_hosting.md) | 2026-08-05 |
| SRC-026 | R | MiroTalk SFU AGPL-3.0 là ứng dụng conferencing hoàn chỉnh trên mediasoup, có UI/domain features riêng | [MiroTalk SFU repository](https://github.com/miroslavpejic85/mirotalksfu) | 2026-08-05 |
| SRC-027 | R | Nextcloud Talk AGPL-3.0 là app chat/call gắn với Nextcloud | [Nextcloud Talk repository](https://github.com/nextcloud/spreed) | 2026-08-05 |

## Maintenance snapshot

GitHub API được truy vấn ngày 2026-08-05 cho thấy các repository LiveKit, mediasoup, Janus, Jitsi, OpenVidu distribution, Element Call, MiroTalk, Nextcloud Talk, Pion và coturn đều không bị archive và đều có cập nhật trong năm 2026. Đây chỉ là tín hiệu activity, không chứng minh production quality.

## Nguồn bị loại khỏi decision path

- Stringee và các managed-only API: không vượt self-host hard gate.
- Marketing comparison, bài blog tổng hợp và benchmark cũ: không dùng để xếp hạng production.
- Raw memo cũ trong `sources/`: chỉ giữ audit trail, không phải canonical evidence.

## Khoảng trống bắt buộc phải có test/legal evidence

- Browser/mobile reliability trên thiết bị mục tiêu.
- Forced TURN và selected relay candidate.
- Direct-call wrapper effort của LiveKit/mediasoup.
- .NET integration: LiveKit không có official .NET server SDK trong danh sách hiện hành; cần test JWT/Twirp implementation hoặc service adapter.
- Race, multi-tab, reconnect, tenant isolation và webhook/event reconciliation.
- GPL/AGPL obligations và chính sách phân phối/network use.
- CPU/RAM/bandwidth/TURN ratio và on-call effort theo workload thật.

## Sources

### Standards

- [RFC 8825 - Overview: Real-Time Protocols for Browser-Based Applications](https://www.rfc-editor.org/rfc/rfc8825.html)
- [RFC 8445 - ICE](https://www.rfc-editor.org/rfc/rfc8445.html)
- [RFC 8656 - TURN](https://www.rfc-editor.org/rfc/rfc8656.html)
- [RFC 8827 - WebRTC Security Architecture](https://www.rfc-editor.org/rfc/rfc8827.html)
- [W3C WebRTC Statistics API](https://www.w3.org/TR/webrtc-stats/)

### Official project documentation/repositories

- [LiveKit repository](https://github.com/livekit/livekit)
- [LiveKit self-hosting](https://docs.livekit.io/transport/self-hosting/)
- [mediasoup repository](https://github.com/versatica/mediasoup)
- [Janus repository](https://github.com/meetecho/janus-gateway)
- [Jitsi Meet repository](https://github.com/jitsi/jitsi-meet)
- [OpenVidu documentation](https://openvidu.io/latest/docs/)
- [Element Call repository](https://github.com/element-hq/element-call)
- [MiroTalk SFU repository](https://github.com/miroslavpejic85/mirotalksfu)
- [Nextcloud Talk repository](https://github.com/nextcloud/spreed)
- [Pion WebRTC repository](https://github.com/pion/webrtc)
- [coturn repository](https://github.com/coturn/coturn)
