# Báo cáo nghiên cứu: .NET Parallel, Background Job và Vue 2

- Task: [TASK-001](../06-tasks/TASK-001-research-dotnet-parallel-jobs-vue.md)
- Người thực hiện: Đặng Phúc An Khang
- Người nhận: Tín Nguyễn — CTO & Co-founder
- Thời gian thực hiện: 03/08/2026 – 04/08/2026
- Trạng thái: Ready for Review

## Deliverables

- [Báo cáo PDF 10 trang](../../work/TASK-001-dotnet-parallel-background-job-vue2/output/TASK-001-Bao-Cao-Nghien-Cuu-Ky-Thuat.pdf)
- [Nguồn LaTeX](../../work/TASK-001-dotnet-parallel-background-job-vue2/docs/latex/main.tex)
- [Research notes](../../work/TASK-001-dotnet-parallel-background-job-vue2/docs/markdown/research-notes.md)
- [Source log](../../work/TASK-001-dotnet-parallel-background-job-vue2/references/source-log.md)
- [Ví dụ .NET](../../work/TASK-001-dotnet-parallel-background-job-vue2/examples/dotnet/README.md)
- [Ví dụ Vue 2](../../work/TASK-001-dotnet-parallel-background-job-vue2/examples/vue2/README.md)

## Kết quả chính

1. Task Parallel Library (TPL) là thư viện song song tích hợp trong .NET. TPL chia dữ liệu thành các nhóm nhỏ và xếp lịch phần tính toán lên ThreadPool. Parallel chỉ nên được chọn cho phép tính dùng nhiều CPU, đủ lớn và có thể chia thành các phần tương đối độc lập.
2. IHostedService là hợp đồng vòng đời, BackgroundService là lớp cơ sở và Worker Service là mẫu project. Các công cụ có sẵn trong .NET không tự lưu job qua lần khởi động lại; ứng dụng vẫn phải thiết kế xử lý lỗi, thử lại, tính an toàn khi chạy lặp và độ bền của công việc.
3. Thay đổi trực tiếp từ .NET Core 3.1 đến .NET 8 gồm Parallel.ForEachAsync, hành vi xử lý lỗi của BackgroundService, PeriodicTimer, TimeProvider và các thời điểm mở rộng chi tiết hơn trong vòng đời ứng dụng.
4. Vue 2 thường tổ chức component bằng Options API. Vue tạo getter/setter cho các thuộc tính đã khai báo, ghi nhận dữ liệu mà giao diện phụ thuộc và chỉ cập nhật phần DOM bị ảnh hưởng khi state thay đổi.

## Bảng chọn nhanh

| Tình huống | Điểm bắt đầu |
|---|---|
| Tính toán CPU nặng trên nhiều phần tử độc lập | Viết tuần tự trước, sau đó thử Parallel hoặc PLINQ và đo |
| Nhiều thao tác I/O bất đồng bộ | Dùng async/await; giới hạn số thao tác đồng thời nếu cần |
| Vòng lặp hoặc công việc định kỳ trong cùng tiến trình | BackgroundService |
| Hàng đợi trong RAM cần giới hạn dung lượng | Channel kết hợp BackgroundService |
| Job cần được lưu, thử lại và theo dõi | Hangfire |
| Lịch chạy hoặc quan hệ job–trigger phức tạp | Quartz.NET |
| Component Vue 2 | Options API, props, events, v-model, computed và watch |

## Kiểm chứng

- PDF được build bằng XeLaTeX và Biber; log không có citation thiếu, dòng tràn hoặc cảnh báo bố cục.
- Các trang có sơ đồ, code và ảnh output đã được render để kiểm tra: nội dung không bị cắt, bảng có đủ viền ngang/dọc và hình có phần dẫn giải.
- Ví dụ C# được đối chiếu với tài liệu API chính thức. Ví dụ Vue 2 là Single-File Component độc lập và dùng đầy đủ biến xuất hiện trong code.
