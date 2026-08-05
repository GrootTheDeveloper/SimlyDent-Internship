# TASK-001 Workspace

Workspace thực hiện báo cáo nghiên cứu Parallel, Background Job trong .NET/C# và Vue 2.

## Liên kết

- Hồ sơ task: [TASK-001](../../docs/06-tasks/TASK-001-research-dotnet-parallel-jobs-vue.md)
- Khung báo cáo Markdown: [TASK-001-research-report.md](../../docs/07-knowledge/TASK-001-research-report.md)
- Nguồn LaTeX chính: [main.tex](docs/latex/main.tex)
- Nhật ký nguồn: [source-log.md](references/source-log.md)
- Ghi chú nghiên cứu: [research-notes.md](docs/markdown/research-notes.md)

## Cấu trúc

    TASK-001-dotnet-parallel-background-job-vue2/
    ├── docs/
    │   ├── latex/          Nguồn báo cáo LaTeX
    │   └── markdown/       Ghi chú nghiên cứu thô
    ├── assets/
    │   ├── diagrams/       Sơ đồ tự tạo
    │   ├── images/         Hình ảnh đã kiểm tra quyền sử dụng
    │   └── code-output/    Kết quả chạy ví dụ đã làm sạch
    ├── examples/
    │   ├── dotnet/         Ví dụ Parallel và Background Job
    │   └── vue2/           Ví dụ syntax/reactivity Vue 2
    ├── references/         Nhật ký nguồn và claim
    ├── scripts/            Script hỗ trợ build
    └── output/             PDF sinh tự động, không commit

## Quy trình làm việc

1. Ghi câu hỏi và kết quả đọc vào docs/markdown/research-notes.md.
2. Mỗi claim quan trọng phải được ghi nguồn trong references/source-log.md.
3. Viết ví dụ tối thiểu trong examples và lưu kết quả kiểm chứng đã làm sạch vào assets/code-output.
4. Chuyển nội dung đã kiểm chứng sang các section LaTeX.
5. Build bằng scripts/build-latex.ps1.
6. Rà soát PDF trong output trước khi gửi.

## Quy tắc

- Ưu tiên tài liệu chính thức Microsoft Learn, .NET API docs và Vue.js Documentation.
- Không đưa token, dữ liệu khách hàng hoặc mã nguồn nội bộ vào ví dụ.
- Không commit file PDF/intermediate được sinh trong output.
- Mỗi ví dụ chỉ minh họa một ý chính và phải chứa đủ ngữ cảnh để đọc độc lập.
