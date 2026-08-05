# LaTeX Report

## File chính

- main.tex: cấu hình và thứ tự các phần.
- sections/: nội dung báo cáo.
- references.bib: nguồn tham khảo dùng trong báo cáo.

## Build

Yêu cầu XeLaTeX, latexmk và biber. Từ thư mục workspace task, chạy:

    powershell -ExecutionPolicy Bypass -File scripts/build-latex.ps1

PDF được tạo tại output/TASK-001-Bao-Cao-Nghien-Cuu-Ky-Thuat.pdf.

Nếu máy chưa có font Times New Roman, thay giá trị setmainfont trong main.tex bằng font Unicode có sẵn.
