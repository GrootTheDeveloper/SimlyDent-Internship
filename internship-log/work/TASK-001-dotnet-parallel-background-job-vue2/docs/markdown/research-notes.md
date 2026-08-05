# Research Notes

## Câu hỏi và kết luận

| ID | Câu hỏi | Kết luận ngắn | Trạng thái |
|---|---|---|---|
| Q1 | Parallel hoạt động thế nào và dùng khi nào? | Task Parallel Library (TPL) chia dữ liệu thành các nhóm nhỏ và xếp lịch phần tính toán lên ThreadPool. Chỉ nên thử Parallel khi phép tính dùng nhiều CPU, đủ lớn và có thể chia tương đối độc lập. | Đã nghiên cứu |
| Q2 | Background Job có sẵn trong .NET hoạt động thế nào? | Host gọi `IHostedService` theo vòng đời ứng dụng; `BackgroundService` cung cấp `ExecuteAsync`. Ứng dụng vẫn phải thiết kế tín hiệu dừng, vòng đời dependency, thử lại và độ bền của job. | Đã nghiên cứu |
| Q3 | Có gì thay đổi từ .NET Core 3.1 đến .NET 8? | Parallel có `ForEachAsync` từ .NET 6. Công việc chạy nền có hành vi xử lý lỗi mới, `PeriodicTimer`, `TimeProvider` và các thời điểm mở rộng vòng đời chi tiết hơn. | Đã nghiên cứu |
| Q4 | Vue 2 dùng cú pháp gì và cập nhật UI ra sao? | Options API tổ chức component. Vue 2 tạo getter/setter cho state, ghi nhận thuộc tính mà giao diện phụ thuộc, gom các lần cập nhật và chỉ sửa phần DOM cần thiết. | Đã nghiên cứu |

## Ghi nhớ thực dụng

### Parallel

- `Parallel.For`/`ForEach` là API đồng bộ cho CPU-bound.
- `Parallel.ForEachAsync` phù hợp với tập I/O lớn cần giới hạn số thao tác hoạt động; nhóm task nhỏ thường hợp `Task.WhenAll` hơn.
- Shared state là dữ liệu bị nhiều lượt chạy cùng đọc hoặc sửa. Nên tạo kết quả riêng cho từng lượt; dùng quá nhiều lock khiến các thread phải chờ nhau.
- Đo bản tuần tự và bản Parallel trên cùng dữ liệu, ở chế độ Release, có lượt chạy khởi động và nhiều lần lặp; so sánh trung vị và kiểm tra kết quả giống nhau.

### Background Job

- `IHostedService` là hợp đồng vòng đời; `BackgroundService` là lớp cơ sở; Worker Service là mẫu project.
- `StartAsync` ngắn, công việc dài trong `ExecuteAsync`, mọi vòng lặp quan sát token.
- Tạo DI scope cho từng job/lượt khi dùng `DbContext` hoặc service scoped.
- `Channel<T>` có thể buộc bên tạo việc chờ khi hàng đợi đầy, nhưng không giữ dữ liệu qua lần khởi động lại.
- Thử lại cần khoảng chờ tăng dần và thao tác phải an toàn khi chạy lặp; không bắt lỗi rồi bỏ qua.

### Hangfire/Quartz.NET

- Hangfire: thực dụng khi cần persistent job, retry và dashboard.
- Quartz.NET: mạnh ở job/trigger, cron/calendar và lịch phức tạp.
- Không mặc định thêm framework nếu một worker in-process nhỏ đã đáp ứng reliability.

### Vue 2

- Options API: `data`, `methods`, `computed`, `watch` và các hàm vòng đời.
- Props truyền xuống; child `$emit` event lên; không mutate prop.
- Custom `v-model` mặc định dùng `value` prop + `input` event.
- Cơ chế cập nhật phụ thuộc vào thuộc tính đã có lúc khởi tạo; dùng `$set` cho thuộc tính/chỉ số thêm sau hoặc `splice` cho mảng.
- Vue gom các watcher cần chạy vào hàng đợi; dùng `$nextTick` khi cần đọc DOM sau khi Vue cập nhật.

## Hạn chế kiểm chứng cục bộ

- Máy hiện không có .NET SDK nên ví dụ C# được đối chiếu bằng API documentation nhưng chưa compile/run tại local.
- Ví dụ Vue là Single-File Component độc lập và đã được rà soát để không dùng biến chưa khai báo.
