# Kế hoạch nghiên cứu: open-source video call 1:1 trên web

- Task: [TASK-002](../06-tasks/TASK-002-research-web-video-call.md)
- Ngày chuẩn hóa: 2026-08-05
- Trạng thái: Desk screening hoàn tất; chờ feasibility spike

## Research question

Giải pháp open-source, self-hostable nào cho phép SimlyDent xây trải nghiệm video call 1:1 theo user với UI và call lifecycle tùy biến sâu, không phụ thuộc bắt buộc vào hosted media/signaling service, đồng thời có effort và rủi ro vận hành phù hợp stack .NET + Vue 2?

## Thứ tự đánh giá

1. Xác nhận hard gates: source/license, self-host media/signaling, web support, custom UI/API.
2. Screen toàn bộ candidate bằng tài liệu project/repository chính thức.
3. Loại candidate lệch domain trước khi code.
4. Spike LiveKit self-host để kiểm tra integration và operational baseline.
5. Spike mediasoup chỉ ở phần khác biệt quyết định: mức custom, effort media service và observability.
6. Dựng Raw WebRTC + coturn baseline nhỏ để đo NAT/TURN và phần application engineering.
7. Chỉ spike Janus nếu legal chấp nhận GPL-3.0 và VideoCall plugin còn hấp dẫn sau ba spike trên.
8. Lập decision record từ test evidence, không từ feature list.

## Candidate routing

| Candidate | Vai trò | Trạng thái |
|---|---|---|
| LiveKit self-host | Preferred programmable SFU | Spike 1 |
| mediasoup | Maximum-customization comparator | Spike 2 có điều kiện |
| Raw WebRTC + SignalR/WebSocket + coturn | Architecture/TURN baseline | Spike nhỏ song song |
| Janus | Plugin gateway, direct VideoCall conditional | Legal + integration gate |
| Jitsi Meet | Meeting platform | Screened out khỏi core PoC |
| OpenVidu Community | Higher-level LiveKit-compatible distribution | Screened out, chưa có lợi thế rõ |
| Element Call | MatrixRTC application | Screened out do dependency stack |
| MiroTalk SFU | Finished conferencing application | Screened out do domain/license |
| Nextcloud Talk | Nextcloud communication application | Screened out do ecosystem coupling |
| Pion WebRTC | Low-level library | Building block, không phải candidate module |
| Stringee | Managed-only historical comparator | Out of scope |

## Outputs

- [Báo cáo chính](../../work/TASK-002-web-video-call/docs/bao-cao-nghien-cuu-video-call.md)
- [Research protocol](../../work/TASK-002-web-video-call/docs/research-protocol.md)
- [Evidence table](../../work/TASK-002-web-video-call/references/evidence-table.md)
- [Source log](../../work/TASK-002-web-video-call/references/source-log.md)
- [Candidate spike plan](../../work/TASK-002-web-video-call/docs/candidate-spike-plan.md)
- [PoC test matrix](../../work/TASK-002-web-video-call/docs/poc-test-matrix.md)
- [Metrics schema](../../work/TASK-002-web-video-call/docs/poc-metrics-schema.md)
- [Call transition rules](../../work/TASK-002-web-video-call/docs/call-transition-rules.md)
- [Test identities](../../work/TASK-002-web-video-call/docs/test-identities.md)

## Decision rule

Không chọn winner nếu candidate chưa có bằng chứng test cho happy path, forced TURN, mobile callee, reconnect, multi-tab, tenant isolation và idempotent state transition. License/TCO/operations là decision inputs riêng, không được suy ra từ việc “không có phí license”.
