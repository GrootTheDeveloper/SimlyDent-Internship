# Source Log

## Tiêu chí chọn nguồn

1. Ưu tiên tài liệu chính thức và trang đúng phiên bản.
2. Dùng blog kỹ thuật để bổ sung cách giải thích, không thay nguồn gốc cho claim phiên bản.
3. Không dùng ảnh bên ngoài trong PDF; các luồng xử lý được dựng trực tiếp bằng TikZ.

## Danh sách nguồn chính

| ID | Chủ đề | Claim được hỗ trợ | Nguồn | Phiên bản | Ngày truy cập |
|---|---|---|---|---|---|
| SRC-001 | TPL | Task không đồng nghĩa thread; TPL lập lịch/partition work | [Microsoft — TPL](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/task-parallel-library-tpl) | Tổng quan .NET | 2026-08-03 |
| SRC-002 | Data parallelism | `Parallel.For`/`ForEach` chia range/collection | [Microsoft — Data Parallelism](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/data-parallelism-task-parallel-library) | Tổng quan .NET | 2026-08-03 |
| SRC-003 | PLINQ | Overhead, ordering và điều kiện có speedup | [Microsoft — PLINQ Speedup](https://learn.microsoft.com/en-us/dotnet/standard/parallel-programming/understanding-speedup-in-plinq) | Tổng quan .NET | 2026-08-03 |
| SRC-004 | Parallel version | `Parallel.ForEachAsync` được thêm trong .NET 6 | [Microsoft DevBlogs — .NET 6 Performance](https://devblogs.microsoft.com/dotnet/performance-improvements-in-net-6/) | .NET 6 | 2026-08-03 |
| SRC-005 | Hosted service | Lifecycle, Worker template, timer/queue/scoped examples | [Microsoft — Hosted Services](https://learn.microsoft.com/en-us/aspnet/core/fundamentals/host/hosted-services) | ASP.NET Core | 2026-08-03 |
| SRC-006 | Background exception | Thay đổi unhandled exception từ .NET 6 | [Microsoft — Compatibility](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/6.0/hosting-exception-handling) | .NET 6 | 2026-08-03 |
| SRC-007 | Queue | Bounded channel và backpressure | [Microsoft — Queue Service](https://learn.microsoft.com/en-us/dotnet/core/extensions/queue-service) | .NET | 2026-08-03 |
| SRC-008 | Scoped DI | Hosted service là singleton; tạo scope cho scoped dependency | [Microsoft — Scoped BackgroundService](https://learn.microsoft.com/en-us/dotnet/core/extensions/scoped-service) | .NET 8+ sample | 2026-08-03 |
| SRC-009 | Time | `PeriodicTimer`, `TimeProvider` và khả năng kiểm thử | [PeriodicTimer](https://learn.microsoft.com/en-us/dotnet/api/system.threading.periodictimer.waitfornexttickasync), [TimeProvider](https://learn.microsoft.com/en-us/dotnet/api/system.timeprovider?view=net-8.0) | .NET 6–8 | 2026-08-03 |
| SRC-010 | Hangfire | Persistent job, retry, recurring job và dashboard | [Hangfire Documentation](https://docs.hangfire.io/en/latest/) | Current docs | 2026-08-03 |
| SRC-011 | Quartz | Job/trigger và RAM/Ado job stores | [Quartz jobs/triggers](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/jobs-and-triggers.html), [job stores](https://www.quartz-scheduler.net/documentation/quartz-3.x/tutorial/job-stores.html) | Quartz.NET 3.x | 2026-08-03 |
| SRC-012 | Vue 2 syntax | Options object, template, directives và component | [Vue 2 Guide](https://v2.vuejs.org/v2/guide/) | Vue 2 | 2026-08-03 |
| SRC-013 | Vue 2 reactivity | `Object.defineProperty`, dependency tracking, caveats và async queue | [Vue 2 — Reactivity in Depth](https://v2.vuejs.org/v2/guide/reactivity.html) | Vue 2 | 2026-08-03 |
| SRC-014 | Vue 2 component | Props/events và `v-model` = `value` + `input` | [Vue 2 — Components Basics](https://v2.vuejs.org/v2/guide/components.html) | Vue 2 | 2026-08-03 |
| SRC-017 | ThreadPool | .NET quản lý và tái sử dụng các worker thread | [Microsoft — Managed Thread Pool](https://learn.microsoft.com/en-us/dotnet/standard/threading/the-managed-thread-pool) | Tổng quan .NET | 2026-08-04 |
| SRC-018 | CPU-bound và I/O-bound | I/O dùng async/await; CPU có thể dùng TPL khi phù hợp và phải đo | [Microsoft — Asynchronous Programming Scenarios](https://learn.microsoft.com/en-us/dotnet/csharp/asynchronous-programming/async-scenarios) | C# | 2026-08-04 |
| SRC-019 | Đo hiệu năng | Warm-up, nhiều vòng đo và thống kê khi dùng BenchmarkDotNet | [BenchmarkDotNet — Getting Started](https://benchmarkdotnet.org/articles/guides/getting-started.html) | Current docs | 2026-08-04 |
