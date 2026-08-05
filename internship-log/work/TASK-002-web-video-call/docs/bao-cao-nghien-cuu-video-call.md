# Báo cáo nghiên cứu: Giải pháp open-source cho video call 1:1 trên web

- Task: [TASK-002](../../../docs/06-tasks/TASK-002-research-web-video-call.md)
- Người thực hiện: Đặng Phúc An Khang
- Người nhận: Tín Nguyễn - CTO & Co-founder
- Thời gian thực hiện: 04/08/2026 - 05/08/2026
- Trạng thái: Ready for Review - nghiên cứu hoàn tất, LiveKit PoC đã chạy trên laptop và iPhone

## Tài liệu bàn giao

- [Báo cáo PDF](../output/TASK-002-Bao-Cao-Nghien-Cuu-Video-Call.pdf)
- [Nguồn LaTeX](latex/main.tex)
- [Evidence table](../references/evidence-table.md)
- [Source log](../references/source-log.md)
- [Research protocol](research-protocol.md)
- [Kế hoạch PoC](candidate-spike-plan.md)

## Kết quả chính

1. Backend quản lý user, tenant, lời mời, trạng thái và phân quyền. WebRTC quản lý kết nối và truyền media.
2. LiveKit là phương án đề xuất để tiếp tục kiểm chứng. Nền tảng cung cấp máy chủ truyền media, JavaScript SDK, JWT theo phòng và quyền, server API, webhook và khả năng self-host theo giấy phép Apache-2.0.
3. mediasoup cho phép kiểm soát media cấp thấp. Phương án này cần dịch vụ Node.js hoặc Rust và signaling riêng.
4. Raw WebRTC kết hợp coturn là mốc đối chiếu cho kết nối trực tiếp và TURN. Ứng dụng phải tự quản lý kết nối, khôi phục, giám sát và vận hành.
5. Janus yêu cầu phê duyệt GPL-3.0. Jitsi, OpenVidu, Element Call, MiroTalk và Nextcloud Talk bị loại khỏi PoC hiện tại.

## Bảng chọn nhanh

| Nhu cầu | Phương án |
|---|---|
| Cân bằng giữa tùy biến, thời gian triển khai và khả năng tự host | LiveKit |
| Kiểm soát chi tiết media server và chấp nhận xây signaling riêng | mediasoup |
| Baseline 1:1 P2P và kiểm chứng TURN | Raw WebRTC + coturn |
| Gateway có plugin gọi trực tiếp, chấp nhận GPL-3.0 | Janus |
| Chấp nhận giao diện và vòng đời phòng họp | Jitsi |

## Kiểm chứng

- Báo cáo sử dụng tài liệu W3C, IETF, repository và tài liệu chính thức của từng dự án.
- Phân loại giải pháp dựa trên giấy phép, khả năng tự host, mức trừu tượng, khả năng tùy biến, mức phù hợp với .NET/Vue 2 và trách nhiệm vận hành.
- PoC gồm LiveKit Server 1.13.1, ASP.NET Core, SignalR, Vue 2, Redis 7.4 và LiveKit Egress 1.12.0. Smoke test ứng dụng và bảo mật đạt 17/17.
- Tenant isolation, token theo room/identity, duplicate transition, busy reservation, refresh/reconcile, HTTPS API và LiveKit signaling WebSocket đã có bằng chứng kiểm thử.
- Giao diện đã được kiểm tra ở viewport 360x800, 390x844 và trên iPhone thật.
- Laptop và iPhone đã vào cùng phòng, cấp quyền và phát camera/microphone. Laptop nhận được video dọc từ iPhone; video được giữ đúng tỷ lệ, không cắt khung hình.
- Cấu hình chất lượng đặt mục tiêu 720p/30fps, yêu cầu lớp nhận HD và hiển thị WebRTC stats trong cuộc gọi. Cần nghiệm thu lại trên laptop và iPhone để xác nhận chất lượng thực tế.
- Ghi hình phía máy chủ đã tạo MP4 H.264 1280x720, 30fps và AAC; start, stop, finalize, tải file đúng quyền và chặn khác tenant đều đạt.
- Chưa nghiệm thu: A/V hai chiều sau bản sửa, Android, kết nối khác mạng, TURN bắt buộc, reconnect, tải và vận hành.
- Cloudflare Quick Tunnel phục vụ demo HTTPS và WSS. Môi trường production yêu cầu public IP, domain/TLS cố định, media ports và TURN/TLS tự vận hành.
- Trạng thái hiện tại: LiveKit là ứng viên ưu tiên; chưa phê duyệt production.
