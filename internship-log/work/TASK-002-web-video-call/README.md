# TASK-002 Workspace

Canonical workspace cho nghiên cứu giải pháp open-source, self-hostable để xây video call 1:1 trên web.

## Đọc theo thứ tự

1. [Báo cáo chính](docs/bao-cao-nghien-cuu-video-call.md)
2. [Evidence table](references/evidence-table.md)
3. [Source log](references/source-log.md)
4. [Research protocol](docs/research-protocol.md)
5. [Candidate spike plan](docs/candidate-spike-plan.md)
6. [PoC test matrix](docs/poc-test-matrix.md)
7. [Metrics schema](docs/poc-metrics-schema.md)
8. [Call transition rules](docs/call-transition-rules.md)
9. [Test identities](docs/test-identities.md)
10. [Workload/TCO inputs](docs/workload-scenarios.md)
11. [LiveKit 1:1 PoC](poc/livekit-1to1/README.md)
12. [Deploy VPS / khác mạng](poc/livekit-1to1/docs/vps-deploy.md)

## Current decision path

- Preferred spike: LiveKit self-host.
- Differential comparator: mediasoup.
- Architecture/TURN baseline: Raw WebRTC + coturn.
- Conditional after legal gate: Janus.
- Screened out hiện tại: Jitsi, OpenVidu, Element Call, MiroTalk, Nextcloud Talk, Pion và managed-only Stringee.

## Trạng thái

- Desk research: hoàn tất và chuẩn hóa ngày 2026-08-05.
- LiveKit PoC: đã triển khai bằng Docker Compose; build và 17/17 kiểm tra ứng dụng/bảo mật đạt ngày 2026-08-05.
- HTTPS/API/LiveKit signaling qua Quick Tunnel: PASS; tunnel chỉ phục vụ demo, không phải kiến trúc production.
- Responsive viewport 360x800, 390x844 và iPhone thật: đạt trong phạm vi giao diện đã kiểm tra.
- Laptop và iPhone đã cùng vào phòng, cấp quyền và phát media; laptop nhận được video từ iPhone. A/V hai chiều sau bản sửa vẫn cần nghiệm thu cuối.
- Popup lời mời, chấp nhận/từ chối và cửa sổ `/call/{callId}` riêng: đã triển khai.
- Video dọc được giữ đúng tỷ lệ và co theo chiều cao vùng gọi, không crop.
- Video đặt mục tiêu 720p/30fps, phía nhận yêu cầu lớp HD và có bảng WebRTC stats trực tiếp trên màn hình gọi; nghiệm thu lại trên hai thiết bị thật chưa hoàn tất.
- Redis và LiveKit Egress đã chạy; ghi, dừng, lưu và tải MP4 720p đã vượt kiểm thử end-to-end bằng video mẫu.
- Khác mạng: đã có stack VPS (`docker-compose.vps.yml` + TURN); nghiệm thu 2 mạng thật sau khi deploy.
- Reconnect / forced-relay evidence: chưa chạy trên production host.
- Production winner: chưa chọn.
- Recording: đã có PoC; production cần chính sách đồng ý, lưu giữ, mã hóa và audit.

## Quy tắc

- `docs/bao-cao-nghien-cuu-video-call.md` là báo cáo canonical.
- `references/source-log.md` là registry nguồn canonical.
- File trong `sources/`, `archive/` và các package `tmp/` chỉ là historical context.
- Managed-only candidate không được quay lại shortlist nếu hard requirement self-host không thay đổi.
- Không nâng capability từ docs/repository thành production evidence.
- Không dùng screenshot/demo thay raw stats, transition log và security result.

## PDF

- Báo cáo chính được viết trong `docs/latex/sections/` và build bằng XeLaTeX/Biber theo cùng template với TASK-001.
- PDF bàn giao: `output/TASK-002-Bao-Cao-Nghien-Cuu-Video-Call.pdf`.
- File Markdown báo cáo là trang tóm tắt deliverables và kết quả chính; nội dung chi tiết nằm trong báo cáo LaTeX/PDF.
