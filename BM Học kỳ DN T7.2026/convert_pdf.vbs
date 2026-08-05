Dim objWord
On Error Resume Next
Set objWord = CreateObject("Word.Application")
If Err.Number <> 0 Then
    WScript.Echo "ERROR: Cannot create Word.Application - " & Err.Description
    WScript.Quit 1
End If
On Error GoTo 0

objWord.Visible = False
objWord.DisplayAlerts = 0

Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")

Dim inputDir, outputDir
inputDir = "F:\SimlyDent\BM Học kỳ DN T7.2026"
outputDir = "F:\SimlyDent\BM Học kỳ DN T7.2026\_pdf"

If Not fso.FolderExists(outputDir) Then
    fso.CreateFolder(outputDir)
End If

Dim folder, file
Set folder = fso.GetFolder(inputDir)

For Each file In folder.Files
    If LCase(fso.GetExtensionName(file.Name)) = "docx" Then
        Dim docPath, pdfPath
        docPath = file.Path
        pdfPath = outputDir & "\" & fso.GetBaseName(file.Name) & ".pdf"
        
        WScript.Echo "Converting: " & file.Name
        
        On Error Resume Next
        Dim doc
        Set doc = objWord.Documents.Open(docPath)
        If Err.Number = 0 Then
            doc.SaveAs pdfPath, 17  ' wdFormatPDF = 17
            doc.Close 0  ' wdDoNotSaveChanges
            WScript.Echo "  OK: " & pdfPath
        Else
            WScript.Echo "  ERROR opening: " & Err.Description
            Err.Clear
        End If
        On Error GoTo 0
    End If
Next

objWord.Quit
WScript.Echo "Done!"
