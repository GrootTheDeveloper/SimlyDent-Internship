# LaTeX Report

## File chính

- `main.tex`
- `references.bib`
- `sections/*.tex`

## Build

Chạy trong thư mục này:

```powershell
xelatex -interaction=nonstopmode -halt-on-error main.tex
biber main
xelatex -interaction=nonstopmode -halt-on-error main.tex
xelatex -interaction=nonstopmode -halt-on-error main.tex
```

PDF bàn giao được sao chép tới:

- `../../output/TASK-002-Bao-Cao-Nghien-Cuu-Video-Call.pdf`
- `F:/SimlyDent/output/pdf/TASK-002-open-source-video-call-research.pdf`

## Kiểm tra

- Log không có citation hoặc reference chưa giải quyết.
- Không có `Overfull` hoặc `Underfull` box.
- Render toàn bộ trang bằng Poppler trước khi bàn giao.
