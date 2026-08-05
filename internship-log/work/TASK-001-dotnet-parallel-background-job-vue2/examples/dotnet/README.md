# .NET Examples

- `ParallelExamples.cs`: ví dụ CPU-bound không sửa shared state và ví dụ `Parallel.ForEachAsync` nhận giới hạn concurrency từ caller.
- `CleanupWorker.cs`: `BackgroundService` chạy ngay rồi chạy định kỳ, có cancellation, graceful shutdown và DI scope theo từng lượt.

Các snippet nhắm .NET 8. Máy hiện chưa có .NET SDK nên chưa compile tại local; API và chữ ký đã được đối chiếu với Microsoft Learn.
