# Test Identities — TASK-002

- Trạng thái: Template; chưa tạo credential
- Mục đích: đủ identity cho positive flow, busy/multi-tab và cross-tenant negative test

## Identity set tối thiểu

| ID logic | Tenant | Vai trò | Dùng cho |
|---|---|---|---|
| A1 | Tenant A (synthetic) | Caller/callee được phép | Positive flow, cancel, permissions |
| A2 | Tenant A (synthetic) | Caller/callee được phép | Positive flow, incoming, busy, multi-tab |
| A3 | Tenant A (synthetic) | Caller/callee được phép | Giữ cuộc gọi với A2 để kiểm tra `Busy`; kiểm tra không nhận nhầm |
| B1 | Tenant B (synthetic) | User khác tenant | Cross-tenant call/data-access negative test |

Bộ kiểm tra core dùng bốn identity logic. A1/A2/A3 thuộc Tenant A để kiểm tra busy end-to-end: A2 đang gọi A3 khi A1 gọi A2. B1 thuộc Tenant B để kiểm tra tenant isolation. Đây là dữ liệu chức năng, không phải mẫu kiểm thử hiệu năng. File không lưu tài khoản thực tế, username, email hoặc credential.

## Session variants

| Variant | Mục đích |
|---|---|
| A2-tab-1, A2-tab-2 | Kiểm tra first accept wins và dismiss các tab còn lại |
| A1-device-desktop, A1-device-mobile | Kiểm tra policy nhiều thiết bị nếu được bật |
| A2↔A3 active session | Tạo cuộc gọi đang active để A1→A2 kiểm tra `Busy` end-to-end |

## Quy tắc

- Dùng dữ liệu tổng hợp, không dùng tên/số điện thoại/dữ liệu bệnh nhân hoặc nhân viên thật.
- Credential/token nằm trong secret store hoặc biến môi trường cục bộ, không commit và không chụp vào evidence.
- Token phải TTL ngắn, audience/identity/tenant/permission tối thiểu theo candidate.
- Backend ánh xạ internal user ID → provider identity; browser không được tự khai tenant/user tùy ý.
- Mỗi test ghi identity logic (A1/A2/A3/B1), không ghi secret.
- Xóa/rotate credential test sau khi kết thúc đợt PoC theo quy trình của môi trường.

## Registry cần điền ngoài repository

| Field | Owner | Trạng thái |
|---|---|---|
| Môi trường test | Engineering | TBD |
| Internal IDs cho A1/A2/A3/B1 | Engineering | TBD — lưu ngoài repo nếu nhạy cảm |
| Role/permission policy | Product/Engineering | TBD |
| Multi-device policy | Product/Engineering | TBD |
| Credential owner/rotation | Engineering/Security | TBD |
