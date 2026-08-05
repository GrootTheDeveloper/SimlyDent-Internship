# Tổng kết tuần 01

- Thời gian: 03/08/2026 – 09/08/2026
- Trọng tâm: Làm quen và onboarding

## Mục tiêu tuần

- [ ] Hiểu tổng quan công ty, sản phẩm và team.
- [ ] Có quyền truy cập các công cụ cần thiết.
- [ ] Bắt đầu chạy dự án tại môi trường local.

## Công việc hoàn thành

| Task | Kết quả | Minh chứng | Trạng thái |
|---|---|---|---|
| TASK-001 | Báo cáo nghiên cứu .NET Parallel, Background Job và Vue 2 | [Hồ sơ task](../../06-tasks/TASK-001-research-dotnet-parallel-jobs-vue.md) | Done ✅ (Phê duyệt 04/08/2026) |
| TASK-002 | Scope đã xác nhận; protocol/evidence templates đã chuẩn hóa; còn U cần research/spike, chưa chọn giải pháp | [Hồ sơ task](../../06-tasks/TASK-002-research-web-video-call.md) | In Progress |

## Kiến thức đã học

### Kỹ thuật

- Phân biệt media WebRTC với direct-call lifecycle và vai trò của signaling, ICE, STUN/TURN.
- Nhận diện các lớp giải pháp raw WebRTC, self-host, managed SDK và embedded meeting.

### Nghiệp vụ

- Yêu cầu “video call qua web” chưa đồng nghĩa gọi tới số điện thoại hoặc meeting room; phải xác nhận actor và call flow.

### Quy trình làm việc

- Truy vết yêu cầu về nguồn, tách requirement khỏi đề xuất cá nhân và đánh dấu Unknown khi thiếu bằng chứng.
- Công bố test protocol trước khi PoC để hạn chế confirmation bias.
- Tách feasibility spike khỏi comparative PoC để U được kiểm chứng trước khi ứng viên vào vòng so sánh.
- Metric nhiều endpoint phải nêu clock domain; không trừ timestamp từ hai clock chưa đồng bộ.
- Sau review package, giảm rủi ro tài liệu gây nhiễu bằng cách đánh dấu raw memo superseded và đồng bộ evidence/state/test matrix.

## Khó khăn và cách xử lý

- Khó khăn: Ban đầu hiểu sai Project 1 theo hướng Web-to-Phone và dùng ma trận điểm chưa có thang đo/dữ liệu.
- Đã thử: Quay lại câu giao việc gốc, làm rõ actor/use case, đối chiếu chuẩn ISO/W3C/IETF và tách evidence code.
- Kết quả: Scope Web-to-Phone bị loại; direct video call 1:1 trên web đã được người giao xác nhận là core scope; chưa chọn vendor.
- Bài học: Không biến giả định hoặc đề xuất mở rộng thành yêu cầu của người giao; không dùng điểm số chủ quan làm kết luận nghiên cứu.

## Feedback nhận được

- Người giao đã xác nhận working scope của `TASK-002` ngày 2026-08-04; chưa ghi nhận feedback về giải pháp vì nghiên cứu chưa hoàn tất.

## Tự đánh giá

- Làm tốt: Chủ động sửa cách hiểu sai và xây lại phương pháp có thể kiểm chứng.
- Cần cải thiện: Xác nhận scope sớm hơn trước khi mở rộng nghiên cứu giải pháp.
- Mục tiêu tuần sau: Bổ sung bằng chứng còn U, chốt inputs/protocol parameters, chạy feasibility spike rồi mới quyết định comparative PoC.
