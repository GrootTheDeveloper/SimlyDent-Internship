import fitz
from pathlib import Path
import os

PDF_DIR = Path(r"F:\SimlyDent\BM Học kỳ DN T7.2026\_pdf")
IMG_DIR = Path(r"F:\SimlyDent\BM Học kỳ DN T7.2026\_pdf_images")

print(f"PDF_DIR: {PDF_DIR}")
print(f"PDF_DIR exists: {PDF_DIR.exists()}")

IMG_DIR.mkdir(exist_ok=True, parents=True)

pdf_files = sorted(PDF_DIR.glob("*.pdf"))
print(f"Found {len(pdf_files)} PDFs")

for pdf_path in pdf_files:
    doc = fitz.open(str(pdf_path))
    stem = pdf_path.stem
    folder = IMG_DIR / stem
    folder.mkdir(exist_ok=True, parents=True)
    for i, page in enumerate(doc):
        mat = fitz.Matrix(2.0, 2.0)
        pix = page.get_pixmap(matrix=mat)
        img_path = folder / f"page_{i+1:02d}.png"
        pix.save(str(img_path))
    print(f"  {stem}: {len(doc)} pages -> {folder}")
    doc.close()

print("Done!")
