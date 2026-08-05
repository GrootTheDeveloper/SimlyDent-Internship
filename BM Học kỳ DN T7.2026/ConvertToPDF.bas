Sub ConvertToPDF()
    Dim doc As Document
    Dim inputFolder As String
    Dim outputFolder As String
    Dim fileName As String
    
    inputFolder = "F:\SimlyDent\BM Học kỳ DN T7.2026\"
    outputFolder = "F:\SimlyDent\BM Học kỳ DN T7.2026\_pdf\"
    
    ' Create output folder if not exists
    If Dir(outputFolder, vbDirectory) = "" Then
        MkDir outputFolder
    End If
    
    fileName = Dir(inputFolder & "*.docx")
    
    Do While fileName <> ""
        Set doc = Documents.Open(inputFolder & fileName)
        doc.ExportAsFixedFormat _
            outputFileName:=outputFolder & Replace(fileName, ".docx", ".pdf"), _
            ExportFormat:=wdExportFormatPDF
        doc.Close SaveChanges:=False
        fileName = Dir()
    Loop
    
    MsgBox "Done! All files converted to PDF."
End Sub
