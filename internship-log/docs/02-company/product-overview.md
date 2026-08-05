# Tổng quan sản phẩm

- Tên sản phẩm: Chưa xác nhận tên thương mại; loại sản phẩm là ERP nha khoa trên web.
- Người dùng chính: Nhân sự vận hành tại phòng khám nha khoa.
- Vấn đề sản phẩm giải quyết: Quản lý tập trung các nghiệp vụ vận hành phòng khám.
- Các chức năng chính đã biết từ JD: form nhập liệu, bảng dữ liệu, báo cáo, modal, pagination và filter.

## Luồng nghiệp vụ chính

1.
2.
3.

## Các hệ thống liên quan

| Hệ thống | Vai trò | Ghi chú |
|---|---|---|
| Web frontend | Giao diện vận hành bằng Vue 2 + BootstrapVue | Cần xác nhận phiên bản Vue 2 cụ thể từ `package.json` |
| Backend API | Xử lý nghiệp vụ bằng .NET/C# | Kiến trúc Controller–Service/Business–Repository |
| PostgreSQL | Lưu trữ dữ liệu nghiệp vụ | Có yêu cầu tối ưu query, index và tránh N+1 |
