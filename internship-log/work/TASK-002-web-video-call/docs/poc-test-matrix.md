# PoC Test Matrix — TASK-002

- Trạng thái: Đã có feasibility run cục bộ; browser/device/network qualification còn mở
- Core scope: Direct video call 1:1 giữa user web
- Recording: optional R-06, tách khỏi core rows

## Quy tắc khóa protocol

- `N`, thời lượng và sampling interval là **TBD — phải chốt trước khi chạy kèm rationale**; tài liệu không tự đặt số mẫu.
- Mỗi finalist chạy cùng core rows, trừ khi capability không được hỗ trợ; trường hợp đó ghi fail/not supported, không xóa row.
- Mỗi run ghi version chính xác, cấu hình, network, raw evidence và mọi deviation.
- Không gộp “desktop” hoặc “mobile” nếu browser/OS/device khác nhau.

## Run record schema

| Trường | Giá trị cần ghi |
|---|---|
| Run ID | ID duy nhất, ví dụ `CANDIDATE-SCENARIO-RUN` |
| Phase | Feasibility spike / Comparative PoC |
| Candidate | Tên + SDK/server version |
| Caller | Test identity, device, OS, browser + version |
| Callee | Test identity, device, OS, browser + version |
| Network A/B | Loại kết nối, ISP/môi trường được phép ghi, cùng/khác mạng |
| Scenario | Scenario ID bên dưới |
| Duration | TBD trước test |
| Repetitions N | TBD trước test + rationale |
| Config | Region, codec/preset nếu kiểm soát được, TURN policy, feature flags |
| Expected | State/outcome dự kiến |
| Actual | Raw outcome; không chỉ pass/fail |
| Evidence | Log/screenshot/video/raw stats đã làm sạch |
| Deviation | Sai lệch protocol hoặc `None` |
| Optional R-06 | Off cho core; On chỉ trong recording rows |

## Core scenario matrix

| ID | Caller ↔ Callee | Network | Scenario | Expected state/outcome | N |
|---|---|---|---|---|---|
| F-01 | Desktop Chrome/Edge ↔ desktop Chrome/Edge | Cùng mạng | Accept/happy path | `InCall` rồi `Ended`; A/V hai chiều | TBD + rationale |
| F-02 | Desktop ↔ desktop | Khác mạng | Accept/happy path | `InCall`; ghi direct/relay path | TBD + rationale |
| F-03a | Desktop → Chrome Android | Khác mạng | Mobile làm callee: incoming → accept | `InCall`; A/V hai chiều; ghi permission/autoplay/ringtone behavior | TBD + rationale |
| F-03b | Chrome Android → desktop | Khác mạng | Mobile làm caller | `InCall`; A/V hai chiều | TBD + rationale |
| F-04a | Desktop → Safari iOS | Khác mạng | Safari iOS làm callee | SHOULD trong MVP; blocker chỉ khi stakeholder chốt Safari iOS là MUST | TBD + rationale |
| F-04b | Safari iOS → desktop | Khác mạng | Safari iOS làm caller | SHOULD trong MVP; ghi U nếu không có thiết bị/version | TBD + rationale |
| F-05 | Desktop ↔ desktop | Controlled relay test | Forced relay / TURN path | `InCall`; selected candidate path = relay; A/V hai chiều | TBD + rationale |
| S-01 | Desktop ↔ desktop | Một cấu hình đã khóa | Callee reject | `Rejected` | TBD + rationale |
| S-02 | Desktop ↔ desktop | Một cấu hình đã khóa | Caller cancel trước accept | `Cancelled` | TBD + rationale |
| S-03 | A1 → A2 trong khi A2↔A3 đang `InCall` | Một cấu hình đã khóa | Callee bận | Call mới nhận `Busy`; call hiện hữu không bị ảnh hưởng | TBD + rationale |
| S-04 | Desktop ↔ desktop | Một cấu hình đã khóa | Không có eligible online session | `Unavailable`, không phải `Missed` | TBD + rationale |
| S-05 | Desktop ↔ desktop | Một cấu hình đã khóa | Đã ringing nhưng không trả lời | `Missed` sau timeout đã cấu hình | TBD + rationale |
| P-01 | Desktop ↔ desktop | Một cấu hình đã khóa | Camera denied | UI/state/error đúng policy đã chốt | TBD + rationale |
| P-02 | Desktop ↔ desktop | Một cấu hình đã khóa | Microphone denied | UI/state/error đúng policy đã chốt | TBD + rationale |
| N-01 | Desktop/mobile ↔ desktop | Khác mạng | Mạng gián đoạn rồi phục hồi | `Reconnecting` → `InCall` hoặc terminal theo timeout đã chốt | TBD + rationale |
| R-01 | A1 ↔ A2 | Một cấu hình đã khóa | Hai tab của cùng callee cùng nhận; một tab accept | Một accept thắng, tab còn lại dismiss | TBD + rationale |
| R-02 | A1 ↔ A2 | Một cấu hình đã khóa | Caller cancel đồng thời callee accept | Chỉ một atomic transition thắng | TBD + rationale |
| R-03 | A1 ↔ A2 | Một cấu hình đã khóa | Callback trùng/lệch thứ tự | Không nhân đôi event/terminal state | TBD + rationale |
| A-01 | A1 → B1 | Một cấu hình đã khóa | Cross-tenant call | Bị từ chối trước khi phân phối | TBD + rationale |
| A-02 | B1 → call của Tenant A | Một cấu hình đã khóa | Đọc call data trái tenant | Bị từ chối, không lộ metadata | TBD + rationale |
| A-03 | Provider callback endpoint | Một cấu hình đã khóa | Invalid/forged provider webhook | Reject, state unchanged, audit event nếu policy cho phép | TBD + rationale |
| A-04 | Client token | Một cấu hình đã khóa | Expired/invalid client token | Không thể connect/obtain unauthorized room | TBD + rationale |
| A-05 | Stale online session | Một cấu hình đã khóa | Presence lease hết hạn hoặc websocket ghost | Không ghost ringing; `Unavailable` hoặc terminal policy đúng định nghĩa | TBD + rationale |
| R-04 | A1 ↔ A2 | Một cấu hình đã khóa | Refresh tab khi `Ringing` | UI reconcile theo backend state; không tạo call mới | TBD + rationale |
| R-05 | A1 ↔ A2 | Một cấu hình đã khóa | Refresh tab khi `InCall` | Reconnect hoặc terminal state theo timeout policy | TBD + rationale |
| M-01 | Mobile ↔ desktop | Một cấu hình đã khóa | Đổi camera/xoay màn hình | Hành vi được ghi theo browser/device | TBD + rationale |
| M-02 | Mobile ↔ desktop | Một cấu hình đã khóa | Background/lock/suspend | Ghi raw behavior và limitation; không ngoại suy | TBD + rationale |

## Optional R-06 matrix

Chỉ bật sau khi recording scope, consent, quyền và retention được duyệt.

| ID | Scenario | Expected | N |
|---|---|---|---|
| O-01 | Start/stop/finalize recording theo consent flow | Artifact và state khớp policy | Pass 1/1 với video mẫu; consent production chưa duyệt |
| O-02 | User trái quyền/tenant truy cập recording | Bị từ chối; không lộ URL/file | Pass 1/1, khác tenant nhận HTTP 404 |
| O-03 | Kiểm tra completeness/A-V sync | Ghi raw observation và measurement method | TBD + rationale |

## Coverage ledger

Trước khi báo cáo, lập bảng Candidate × Scenario ID với trạng thái `Not run / Pass / Fail / Blocked / Not supported`; mọi ô phải có evidence hoặc lý do.

## Kết quả feasibility hiện có

| Phạm vi | Kết quả | Bằng chứng/giới hạn |
|---|---|---|
| Build và khởi động stack | Pass | Docker Compose; LiveKit 1.13.1, ASP.NET Core, Vue 2 |
| Application/security smoke | Pass, 17/17 | Tenant isolation, token scope, recording gate, duplicate transition, busy và refresh ringing |
| Recording Egress | Pass, 1/1 | MP4 H.264 1280x720 30fps + AAC; tải đúng quyền, khác tenant bị chặn |
| HTTPS API qua Quick Tunnel | Pass | `/api/identities` trả 200; URL tunnel không cố định |
| LiveKit signaling WSS | Pass | WebSocket kết nối và nhận frame signaling đầu tiên |
| Responsive 390x844 | Pass | Không tràn ngang/chiều cao; đã đối chiếu thêm trên iPhone thật |
| Responsive 360x800 | Pass | Không tràn ngang/chiều cao; browser viewport, không phải Android thật |
| Media thiết bị thật | Partial | Laptop và iPhone cùng publish; laptop nhận video iPhone; chưa nghiệm thu A/V hai chiều sau bản sửa |
| Khác mạng | Not run | LiveKit vẫn quảng bá IP LAN |
| Forced TURN/relay | Not run | Chưa triển khai TURN/public host |
| Reconnect/raw WebRTC stats | Not run | Chưa thu selected candidate và metrics |
