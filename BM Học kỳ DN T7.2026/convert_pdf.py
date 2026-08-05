"""Convert all DOCX to PDF using Word COM via comtypes."""
import os
from pathlib import Path
import comtypes.client

INPUT_DIR = Path(r"F:\SimlyDent\BM Học kỳ DN T7.2026")
PDF_DIR = INPUT_DIR / "_pdf"
PDF_DIR.mkdir(exist_ok=True)

wdFormatPDF = 17

word = comtypes.client.CreateObject('Word.Application')
word.Visible = False

docx_files = sorted(INPUT_DIR.glob("*.docx"))
print(f"Found {len(docx_files)} DOCX files")

for docx_path in docx_files:
    pdf_path = PDF_DIR / (docx_path.stem + ".pdf")
    print(f"  {docx_path.name} -> {pdf_path.name} ...", end=" ")
    try:
        doc = word.Documents.Open(str(docx_path))
        doc.SaveAs(str(pdf_path), FileFormat=wdFormatPDF)
        doc.Close()
        print("OK")
    except Exception as e:
        print(f"ERROR: {e}")

word.Quit()
print("Done!")
