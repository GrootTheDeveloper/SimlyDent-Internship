# TASK-001: Nghiên cứu .NET Parallel, Background Job và Vue 2

## Metadata

- Trạng thái: Done ✅
- Trạng thái phạm vi: Đã duyệt ngày 2026-08-03
- Ngày nhận: 2026-08-03
- Ngày bắt đầu: 2026-08-03
- Hạn hoàn thành: Chiều 2026-08-04
- Ngày hoàn thành: 2026-08-04
- Ngày được phê duyệt: 2026-08-04
- Người phê duyệt: Tín Nguyễn — CTO & Co-founder
- Người giao: Tín Nguyễn — CTO & Co-founder
- Team: Kỹ thuật
- Người review: Tín Nguyễn
- Loại task: Research / Technical report
- Ticket: Không có
- Repository: `internship-log`
- Branch: Không áp dụng
- Pull request: Không áp dụng
- Báo cáo: [TASK-001-research-report.md](../07-knowledge/TASK-001-research-report.md)
- Workspace thực hiện: [work/TASK-001-dotnet-parallel-background-job-vue2](../../work/TASK-001-dotnet-parallel-background-job-vue2/README.md)

## Yêu cầu gốc

> Nghiên cứu .NET, C# về parallel, Job; các phần thay đổi của .NET 8 so với .NET 3.1. Nghiên cứu Vue.js syntax và cơ chế hoạt động. Cho anh bản báo cáo tóm tắt nghiên cứu vào chiều ngày mai.

## Mục tiêu

Tạo một báo cáo ngắn gọn, có cấu trúc và đủ nền tảng để giải thích:

1. Parallel trong .NET/C# hoạt động thế nào và nên dùng khi nào.
2. Background Job hoạt động thế nào và các cách triển khai phổ biến trong .NET.
3. Những thay đổi/cải tiến liên quan đến hai chủ đề trên từ .NET Core 3.1 đến .NET 8.
4. Cú pháp chính và cơ chế reactivity/rendering của Vue 2.

## Logic nghiên cứu và trình bày

```text
Phân loại loại công việc
→ Parallel giải quyết bài toán nào?
→ Background Job giải quyết bài toán nào?
→ .NET cung cấp công cụ built-in gì?
→ .NET 8 cải thiện gì so với .NET Core 3.1?
→ Khi built-in không đủ thì dùng gì?
→ Vue 2 viết component như thế nào?
→ State thay đổi thì UI cập nhật ra sao?
```

## Phạm vi đã duyệt

### 1. Khái niệm nền

- Phân biệt concurrency, parallelism, asynchronous programming và background processing.
- Phân biệt công việc CPU-bound và I/O-bound.
- Phân biệt `Task`, `async/await`, Parallel và Background Job ở mức tổng quan.
- Mục tiêu: xác định đúng công cụ cho từng loại công việc trước khi đi vào API.

### 2. .NET/C# — Parallel

- Bài toán Parallel giải quyết: tận dụng nhiều CPU core cho công việc CPU-bound.
- Cơ chế Task Parallel Library và ThreadPool ở mức tổng quan; không đi sâu thuật toán scheduling.
- API: `Parallel.For`, `Parallel.ForEach`, `Parallel.ForEachAsync` và PLINQ.
- Cancellation, exception, thread safety, shared state và giới hạn mức độ song song.
- Chi phí chia nhỏ, lập lịch và đồng bộ công việc.
- Bảng quyết định khi nào dùng Parallel, xử lý tuần tự hoặc `async/await`.
- Chỉ chọn 3–5 thay đổi/cải tiến đáng chú ý từ .NET Core 3.1 đến .NET 8 có tác động trực tiếp tới developer.

### 3. .NET — Job/Background Task

- Bài toán Background Job giải quyết: công việc cần chạy ngoài vòng đời HTTP request.
- Quan hệ giữa `IHostedService`, `BackgroundService` và Worker Service.
- Vòng đời start → execute → cancellation → graceful shutdown.
- Ba cách chạy ở mức tổng quan: liên tục, định kỳ bằng timer/`PeriodicTimer`, và hàng đợi in-memory.
- Dependency-injection scope, cancellation, exception và chạy nhiều job.
- Các rủi ro: retry, idempotency, job chồng lặp và mất công việc khi process dừng.
- Chỉ chọn các thay đổi/cải tiến liên quan trực tiếp từ .NET Core 3.1 đến .NET 8 về hosting, lifecycle/exception, timer, cancellation và khả năng kiểm thử.

### 4. Phân biệt ngắn built-in với Hangfire/Quartz.NET

- Giải thích vì sao `BackgroundService` chưa phải hệ thống quản lý job hoàn chỉnh.
- So sánh ngắn về persistence, scheduling, retry, dashboard và trường hợp sử dụng.
- Không nghiên cứu cài đặt, database schema, dashboard, clustering hoặc triển khai production.

### 5. Vue 2 syntax

- Single-File Component: `<template>`, `<script>`, `<style>`.
- Interpolation `{{ value }}`.
- Directive: `v-if`, `v-show`, `v-for`, `v-bind`/`:`, `v-on`/`@`, `v-model`.
- Component, props, events/`emit` và slots ở mức cơ bản.
- Options API là cách tổ chức chính: `data`, `methods`, `computed`, `watch` và lifecycle hook cơ bản.
- Quy ước props down, events up; `v-model` trên component tương đương `value` prop + `input` event trong Vue 2.

### 6. Cơ chế hoạt động của Vue 2

- Khởi tạo reactive state từ các property khai báo sẵn trong `data`.
- `Object.defineProperty`, getter/setter, dependency tracking và watcher ở mức tổng quan.
- Các giới hạn phát hiện thay đổi của object/array; dùng `Vue.set`/`this.$set` hoặc `splice` đúng lúc.
- Template compilation, render function và Virtual DOM.
- Async update queue, batching, diffing và patching.
- Luồng state thay đổi → dependency bị ảnh hưởng → render → Virtual DOM → cập nhật DOM thật.

## Phạm vi không đi sâu

- Toàn bộ thay đổi của .NET Core 3.1 đến .NET 8 hoặc lịch sử chi tiết từng phiên bản.
- Nội bộ ThreadPool, benchmark Parallel và tối ưu production.
- Distributed job processing, message broker hoặc triển khai Hangfire/Quartz.NET hoàn chỉnh.
- Vue Router, Vuex, Nuxt/SSR và migration Vue 2 → Vue 3.
- Composition API, mixin/slot nâng cao và kiến trúc Vue quy mô lớn.

## Tiêu chí hoàn thành

- [x] Giải thích rõ các khái niệm và không đánh đồng Parallel với `async/await` hoặc Background Job.
- [x] Có ví dụ ngắn cho các API Parallel phổ biến.
- [x] Giải thích đúng quan hệ và vòng đời của `IHostedService`, `BackgroundService`, Worker Service.
- [x] Có bảng so sánh thay đổi liên quan giữa .NET Core 3.1 và .NET 8.
- [x] Có bảng phân biệt built-in Background Service, Hangfire và Quartz.NET.
- [x] Có ví dụ Vue 2 bằng Options API, thể hiện syntax, props/emit, `v-model` và luồng state → render.
- [x] Có phần khi nào nên/không nên sử dụng.
- [x] Có liên kết tới nguồn chính thức và ghi rõ phiên bản.
- [x] Báo cáo đủ ngắn để đọc trong khoảng 15–20 phút.
- [x] Báo cáo được rà soát và gửi trong chiều 04/08/2026.

## Kế hoạch nghiên cứu một ngày

| Thời lượng | Nội dung |
|---:|---|
| 30 phút | Chốt câu hỏi, cấu trúc và nguồn chính thức |
| 90 phút | Parallel: cơ chế, API và trường hợp sử dụng |
| 90 phút | Background Job built-in |
| 30 phút | Phân biệt Hangfire/Quartz.NET |
| 45 phút | Thay đổi .NET Core 3.1 → .NET 8 |
| 120 phút | Vue 2 syntax, reactivity và rendering |
| 75 phút | Viết báo cáo, ví dụ code và kết luận |
| 30 phút | Kiểm chứng, rút gọn và rà soát |

## Rủi ro

- Có thể sa đà vào thay đổi không liên quan giữa các phiên bản .NET; giới hạn tối đa 3–5 điểm chính cho mỗi chủ đề.
- “Job” không phải một abstraction duy nhất; báo cáo phải tách hosted service in-process khỏi persistent scheduler.
- Có thể quá tải nội dung Vue; ưu tiên Options API, props/emit, `v-model`, các bẫy reactivity và luồng state → render.

## Kết quả và bài học

- Bản báo cáo PDF 10 trang đã build bằng XeLaTeX/Biber; các trang có sơ đồ, code và ảnh output đã được kiểm tra trực quan: [TASK-001-Bao-Cao-Nghien-Cuu-Ky-Thuat.pdf](../../work/TASK-001-dotnet-parallel-background-job-vue2/output/TASK-001-Bao-Cao-Nghien-Cuu-Ky-Thuat.pdf).
- Nguồn LaTeX, sơ đồ TikZ, ví dụ code và source log nằm trong [task workspace](../../work/TASK-001-dotnet-parallel-background-job-vue2/README.md).
- Báo cáo chỉ trình bày Vue 2, không phụ thuộc JD hoặc giả định về codebase công ty.
- Bài học chính: phân loại CPU/I/O/vòng đời trước khi chọn API; built-in background service không đồng nghĩa persistent job system; Vue 2 có các caveat reactivity cần nhớ.
- Chờ người thực hiện điền họ tên và duyệt nội dung trước khi gửi anh Tín; chưa commit các thay đổi của vòng nghiên cứu này.
- **Cập nhật 2026-08-04:** Báo cáo đã được Tín Nguyễn (CTO) phê duyệt. Task hoàn thành.
