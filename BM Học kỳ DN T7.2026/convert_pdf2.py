"""
Convert DOCX to PDF by launching Word as a subprocess with a VBA macro.
Uses the Word command line: WINWORD.EXE /m<macro>
"""
import subprocess
import os
import time
from pathlib import Path

INPUT_DIR = Path(r"F:\SimlyDent\BM Học kỳ DN T7.2026")
PDF_DIR = INPUT_DIR / "_pdf"
PDF_DIR.mkdir(exist_ok=True)

WORD_EXE = r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE"

# Create a temporary Word document with the conversion macro
macro_template = r'''
Sub AutoOpen()
    Dim fso As Object
    Set fso = CreateObject("Scripting.FileSystemObject")
    
    Dim inputFolder As String
    Dim outputFolder As String
    inputFolder = "F:\SimlyDent\BM Học kỳ DN T7.2026\"
    outputFolder = "F:\SimlyDent\BM Học kỳ DN T7.2026\_pdf\"
    
    If Not fso.FolderExists(outputFolder) Then
        fso.CreateFolder outputFolder
    End If
    
    Dim fileName As String
    fileName = Dir(inputFolder & "*.docx")
    
    Do While fileName <> ""
        If fileName <> ThisDocument.Name Then
            Dim doc As Document
            Set doc = Documents.Open(inputFolder & fileName, ReadOnly:=True)
            doc.ExportAsFixedFormat _
                outputFileName:=outputFolder & Replace(fileName, ".docx", ".pdf"), _
                ExportFormat:=wdExportFormatPDF
            doc.Close SaveChanges:=False
        End If
        fileName = Dir()
    Loop
    
    Application.Quit SaveChanges:=False
End Sub
'''

# Alternative: Try using win32com with explicit CLSID
print("Attempting to use win32com with explicit CLSID for Word...")

try:
    import pythoncom
    import win32com.client
    
    # Word 2016/365 CLSID
    WORD_CLSID = "{000209FF-0000-0000-C000-000000000046}"  # Word.Application
    
    pythoncom.CoInitialize()
    
    # Try using DispatchEx instead of Dispatch
    try:
        word = win32com.client.DispatchEx('Word.Application')
    except:
        # Try with gencache
        try:
            word = win32com.client.gencache.EnsureDispatch('Word.Application')
        except:
            # Last resort - try with Moniker
            word = win32com.client.GetObject(Class='Word.Application')
    
    word.Visible = False
    word.DisplayAlerts = 0
    
    docx_files = sorted(INPUT_DIR.glob("*.docx"))
    print(f"Found {len(docx_files)} files")
    
    for f in docx_files:
        pdf_path = PDF_DIR / (f.stem + ".pdf")
        print(f"  {f.name} -> {pdf_path.name} ...", end=" ", flush=True)
        try:
            doc = word.Documents.Open(str(f), ReadOnly=True)
            doc.ExportAsFixedFormat(
                str(pdf_path),
                17,  # wdExportFormatPDF
            )
            doc.Close(0)
            print("OK")
        except Exception as e:
            print(f"ERROR: {e}")
    
    word.Quit()
    print("\nDone!")
    
except Exception as e:
    print(f"COM approach failed: {e}")
    print("\nFalling back to command-line approach...")
    
    # Use PowerShell inline script approach
    ps_script = r'''
    $word = $null
    try {
        # Try to get running Word instance
        $word = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
    } catch {
        Write-Host "No running Word instance found"
    }
    
    if ($word -eq $null) {
        Write-Host "Please open Microsoft Word manually first, then re-run this script."
        Write-Host "Or run the VBA macro ConvertToPDF.bas directly inside Word."
    } else {
        $word.Visible = $false
        $inputDir = "F:\SimlyDent\BM Học kỳ DN T7.2026"
        $outputDir = "F:\SimlyDent\BM Học kỳ DN T7.2026\_pdf"
        
        Get-ChildItem "$inputDir\*.docx" | ForEach-Object {
            $pdfPath = Join-Path $outputDir ($_.BaseName + ".pdf")
            Write-Host "Converting: $($_.Name)..."
            $doc = $word.Documents.Open($_.FullName, $false, $true)
            $doc.ExportAsFixedFormat($pdfPath, 17)
            $doc.Close(0)
            Write-Host "  OK"
        }
        
        Write-Host "Done!"
    }
    '''
    
    result = subprocess.run(
        ["powershell", "-Command", ps_script],
        capture_output=True, text=True, timeout=120
    )
    print(result.stdout)
    if result.stderr:
        print("ERRORS:", result.stderr)
