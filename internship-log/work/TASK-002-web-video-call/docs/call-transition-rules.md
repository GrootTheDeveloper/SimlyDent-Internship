# Call Transition and Race Rules — TASK-002

- Trạng thái: Core protocol draft
- Source of truth: Backend call session + append-only event log

## State semantics

| State | Ý nghĩa |
|---|---|
| `Initiated` | Backend đã nhận và xác thực yêu cầu tạo call |
| `Ringing` | Ít nhất một eligible callee session đã nhận invitation |
| `Connecting` | Accept thắng race; đang thiết lập media |
| `InCall` | Media core đã kết nối theo điều kiện PoC |
| `Reconnecting` | Đã ở `InCall`, hiện mất kết nối/media và đang thử phục hồi |
| `Unavailable` | Không có eligible online callee session tại lúc phân phối |
| `Busy` | Callee/caller đã được reservation bởi cuộc gọi khác theo one-call policy |
| `Rejected` | Callee chủ động từ chối khi đang `Ringing` |
| `Missed` | Đã `Ringing` nhưng không accept trước timeout cấu hình |
| `Cancelled` | Caller hủy trước khi accept thắng |
| `Failed` | Lỗi phân phối/kết nối không thuộc busy/unavailable/reject/miss/cancel |
| `Ended` | Cuộc gọi đã `InCall` kết thúc |

## Allowed transitions

| From | To |
|---|---|
| `Initiated` | `Ringing`, `Unavailable`, `Busy`, `Failed`, `Cancelled` |
| `Ringing` | `Connecting`, `Rejected`, `Missed`, `Cancelled`, `Failed` |
| `Connecting` | `InCall`, `Failed`, `Cancelled` chỉ nếu policy cho phép trước media-established |
| `InCall` | `Reconnecting`, `Ended` |
| `Reconnecting` | `InCall`, `Ended` |

`Unavailable`, `Busy`, `Rejected`, `Missed`, `Cancelled`, `Failed` và `Ended` là terminal business states. Callback đến muộn không được tự đổi terminal state; nếu cần correction vận hành, phải tạo audit event riêng và policy được duyệt.

## Atomicity và idempotency

- Mỗi session có `version`. Command transition gửi `expected_version`; backend dùng transaction/atomic compare-and-set.
- Mỗi command có `idempotency_key`; mỗi provider event có `provider_event_id` hoặc deduplication fingerprint có phạm vi/thời hạn được định nghĩa.
- Duplicate command/event trả lại kết quả đã lưu, không tạo transition/call log/recording thứ hai.
- Out-of-order event được lưu để audit nhưng chỉ áp dụng nếu transition hợp lệ với version/state hiện tại.
- Event log append-only chứa internal call ID, provider call ID, version, source, observed/received timestamps và sanitized payload reference.

## Race rules

### Cancel đồng thời Accept

`cancel(Ringing→Cancelled)` và `accept(Ringing→Connecting)` tranh cùng expected version. Transition commit đầu tiên thắng; request còn lại nhận conflict/current state và UI reconciliation theo backend state. Không dùng thứ tự event tại browser làm nguồn sự thật.

### Hai cuộc gọi đồng thời A ↔ B

MVP áp dụng one-active-call reservation. Việc tạo call kiểm tra và reserve cả caller/callee trong cùng transaction. Call được commit reservation đầu tiên tiếp tục; call còn lại nhận `Busy`. Không dùng call UUID hay client timestamp để quyết định.

### Nhiều tab/thiết bị của callee

Các eligible session có thể cùng nhận invitation. Accept đầu tiên chuyển `Ringing→Connecting`; backend phát event dismiss/reconcile cho session còn lại. Accept đến sau nhận current state, không tạo media session thứ hai.

### Callback đến sau terminal state

Callback chỉ bổ sung diagnostic/provider metadata nếu an toàn; không hồi sinh session. Mọi khác biệt provider/backend được ghi reconciliation event và xuất hiện trong test report.

## Timeout policy

Ringing timeout, connect timeout và reconnect timeout đều là **TBD — stakeholder/engineering phải chốt trước test kèm rationale**. Không tự đặt giá trị sau khi xem kết quả. Timeout version/config phải được ghi trong mỗi run.

