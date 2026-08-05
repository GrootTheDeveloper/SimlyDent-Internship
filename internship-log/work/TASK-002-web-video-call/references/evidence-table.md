# Evidence Table - TASK-002

- Snapshot: 2026-08-05
- Codes: `P/R` official project/repository, `T` team test, `L` legal, `U` unknown
- Desk evidence không tự động nâng candidate thành production-qualified.

## Hard-gate screening

| Candidate | OSS/license | Full self-host | Custom UI/API | Activity signal | Desk result |
|---|---|---|---|---|---|
| LiveKit | R: Apache-2.0 | P: server self-host | P: browser SDK, room/track APIs | R: active 2026 | Include |
| mediasoup | R: ISC | R: Node/Rust media service | R: very low-level, signaling-agnostic | R: active 2026 | Include |
| Raw WebRTC + coturn | S + R: coturn OSS | Có, tự xây | Toàn quyền | R: coturn/Pion active 2026 | Include as baseline |
| Janus | R: GPL-3.0 | R/P: gateway self-host | P: plugin/API; app UI tự xây | R: active 2026 | Conditional: legal gate |
| Jitsi Meet | R: Apache-2.0 | P: Docker/Debian self-host | Có IFrame/fork, nhưng meeting-first | R: active 2026 | Screen out core PoC |
| OpenVidu Community | R/P: Apache-2.0 distribution | P: Community single-node | LiveKit-compatible API | R: active 2026 | Screen out; added layer/edition gate |
| Element Call | R: AGPL-3.0 | P: self-host | App/widget customization | R: active 2026 | Screen out; Matrix stack coupling |
| MiroTalk SFU | R: AGPL-3.0 | R: self-host | Full app/rebrand | R: active 2026 | Screen out; finished meeting app |
| Nextcloud Talk | R: AGPL-3.0 | R: self-host | Nextcloud app extension | R: active 2026 | Screen out; ecosystem coupling |
| Pion | R: MIT | Library | Lowest-level APIs | R: active 2026 | Building block only |
| Stringee | Managed service | Không có full self-host path trong scope | SDK phụ thuộc service | Không xét | Exclude by hard gate |

## Core evidence cho shortlist

| Core question | LiveKit | mediasoup | Raw WebRTC + coturn | Janus |
|---|---|---|---|---|
| Direct call theo user | T: create/incoming/accept/reject/cancel/end/busy; no-answer chưa triển khai | U/T: tự xây toàn bộ signaling/lifecycle | U/T: tự xây toàn bộ | P: VideoCall demo semantics; production auth/state U |
| Browser media SDK | P: official JS client | P/R: mediasoup-client | S: native WebRTC API | P/R: JS demos/API |
| Token/authorization | T: JWT chỉ cấp sau accept, room/identity scoped, TTL 5 phút | U/T: application-defined | U/T: application-defined | P: token auth; domain mapping U/T |
| Tenant isolation | T: cross-tenant create 403, read 404 | U/T | U/T | U/T |
| TURN/relay control | P: UDP/TCP/TURN architecture; exact forced-relay path T | T: application/server config | S/P: full RTCConfiguration + coturn | P/R: libnice/TURN REST support; T needed |
| Mobile web reliability | T: responsive PASS; iPhone thật đã cấp quyền, vào phòng và phát media; nghiệm thu hai chiều còn mở | U/T | U/T | U/T |
| Multi-tab/race/reconnect | T: duplicate accept và refresh ringing PASS; multi-device/reconnect U | U/T | U/T | U/T |
| Server events/observability | P: webhooks/server APIs | Application-defined | Application-defined | P: event handlers/API; reconciliation T |
| Recording optional | P: Egress, separate service + Redis | Custom pipeline | Custom pipeline | Plugin/post-processing path; U for product fit |
| .NET backend fit | T: HS256 JWT và application state hoạt động; Room Service chưa dùng | U/T: Node/Rust sidecar required | T: SignalR fits, media state custom | U/T: gateway adapter required |
| License gate | Permissive; L still required | Permissive; L still required | Browser standards + coturn license review | GPL-3.0 requires L |

## Qualification snapshot

| Candidate | Status | Lý do chưa qualified | Next action |
|---|---|---|---|
| LiveKit | Đã kiểm chứng một phần - phương án ưu tiên | Laptop nhận video từ iPhone; A/V hai chiều, Android, khác mạng, TURN, reconnect, tải và vận hành chưa hoàn tất | Hoàn tất kiểm thử production |
| mediasoup | Not qualified - comparator | Direct-call stack và Node/Rust service effort còn U/T | Spike phần khác biệt sau LiveKit |
| Raw WebRTC + coturn | Not qualified - baseline | Production reliability và engineering scope còn U/T | Minimal P2P/TURN baseline |
| Janus | Conditional/unqualified | GPL legal gate và integration ergonomics chưa rõ | Legal screen, rồi mới quyết định spike |

## Decision constraint

Nghiên cứu và PoC đủ để giữ LiveKit làm phương án ưu tiên, chưa đủ để chọn cho production. Quyết định cuối cần kết quả kiểm thử A/V hai chiều, Android/iOS, khác mạng, TURN, reconnect, bảo mật và vận hành.
