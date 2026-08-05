# Research Protocol - Open-source Web Video Call

- Task: [TASK-002](../../../docs/06-tasks/TASK-002-research-web-video-call.md)
- Phiên bản: 2026-08-05
- Core scope: direct video call 1:1 giữa hai user web đã đăng nhập

## Research question

Candidate open-source/self-hostable nào đáp ứng direct-call lifecycle, custom UI, browser/mobile reliability, network traversal, security và operations với mức effort phù hợp SimlyDent?

## Inclusion criteria

Candidate được đưa vào screening khi thỏa tất cả điều kiện desk-level:

- Có repository công khai và license nhận diện được.
- Không bắt buộc sử dụng hosted signaling/media service của nhà cung cấp.
- Có WebRTC web client/API hoặc giao thức đủ để tự xây web client.
- Có hoạt động bảo trì gần đây hoặc release hiện hành tại ngày khảo sát.
- Cho phép ứng dụng sở hữu identity mapping, authorization và UI.

## Exclusion criteria khỏi comparative PoC

- Managed-only runtime.
- Sản phẩm hoàn chỉnh gắn với domain khác và không có media API độc lập hợp lý.
- Cần thay toàn bộ identity/messaging stack hiện có chỉ để có video call.
- License chưa được legal chấp nhận và candidate không tạo lợi thế kỹ thuật đủ lớn.
- Candidate chỉ là library building block, không giảm đáng kể media/application effort so với baseline.

## Evidence codes

| Code | Ý nghĩa | Được phép kết luận |
|---|---|---|
| S | Standard/RFC/W3C | Hành vi chuẩn, không phải chất lượng implementation |
| P | Official project documentation | Capability được project công bố |
| R | Source repository/release/license | Hoạt động, license và đặc điểm code công khai |
| T | Test evidence do team chạy | Kết quả trong môi trường và protocol cụ thể |
| L | Legal/commercial confirmation | Nghĩa vụ license, support hoặc điều khoản |
| U | Unknown | Không được suy ra |

GitHub stars, commit gần đây và release chỉ là maintenance signal; không phải bằng chứng reliability, security hoặc scale.

## Core scenarios

1. A1 gọi A2; A2 accept; audio/video hai chiều; một bên hangup.
2. A1 gọi A2; A2 reject.
3. A1 cancel trước khi A2 accept.
4. A1 gọi A2 khi A2 đang bận.
5. No-answer timeout.
6. A1 gọi user B1 khác tenant và bị backend từ chối trước khi cấp media credential.
7. A2 có nhiều tab/session; chỉ một session thắng accept.
8. Mạng thay đổi hoặc gián đoạn ngắn; state reconnect/end nhất quán.
9. Forced TURN hoặc bằng chứng selected candidate type là relay.
10. Desktop caller đến mobile-web callee trên thiết bị thật.

## Variables to record

- Candidate/version/commit hoặc image tag.
- Browser, OS, device và network.
- Topology: P2P, SFU/gateway, direct hay relay.
- Time-to-invitation, time-to-accept, time-to-first-media.
- Packet loss, jitter, RTT, bitrate, frames/resolution và selected candidate pair.
- Backend transition log, provider/media event log và token claims đã che secret.
- CPU, RAM, outbound bandwidth và TURN ratio.
- Code diff/LOC chỉ dùng như effort signal, không dùng làm chất lượng tuyệt đối.

## Bias controls

- Khóa test matrix và success criteria trước khi chạy.
- Dùng cùng identity, browser/network cases cho candidate được so sánh.
- Không dùng hai tab cùng máy làm bằng chứng remote/mobile.
- Không tuyên bố TURN hoạt động nếu chỉ thấy kết nối thành công.
- Không tuyên bố production-ready từ một happy-path demo.
- Không cộng điểm tùy ý; dùng hard gate, ordinal trade-off và raw metrics.

## Decision rule

- **Preferred:** vượt toàn bộ hard gates, không có security failure và có ops/TCO chấp nhận được.
- **Conditional:** có thể đạt nhưng còn legal/operations/stack constraint phải được chấp nhận rõ.
- **Rejected:** không vượt hard gate hoặc yêu cầu thay đổi kiến trúc ngoài phạm vi.
- **Unqualified:** còn U/T ở core gate.

Desk research và feasibility PoC cho phép giữ LiveKit làm candidate ưu tiên. Chưa cho phép chọn production winner trước khi hoàn thành media/device/network/TURN và operations gates.
