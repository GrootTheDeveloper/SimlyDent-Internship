@echo off
echo ============================================
echo   FIX WORD COM REGISTRATION
echo   (Phai chay voi quyen Administrator)
echo ============================================
echo.

echo [1/3] Dang ky lai Word COM...
"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE" /regserver
timeout /t 5 /nobreak >nul

echo [2/3] Kiem tra ket qua...
reg query "HKLM\SOFTWARE\Classes\Word.Application" >nul 2>&1
if %errorlevel%==0 (
    echo    OK: Word.Application da duoc dang ky!
) else (
    echo    CHUA THANH CONG - Thu dang ky thu cong...
    echo [2b/3] Dang ky thu cong ProgID...
    reg add "HKLM\SOFTWARE\Classes\Word.Application" /ve /d "Microsoft Word Application" /f
    reg add "HKLM\SOFTWARE\Classes\Word.Application\CLSID" /ve /d "{000209FF-0000-0000-C000-000000000046}" /f
    reg add "HKLM\SOFTWARE\Classes\Word.Application\CurVer" /ve /d "Word.Application.16" /f
    reg add "HKLM\SOFTWARE\Classes\Word.Application.16" /ve /d "Microsoft Word Application" /f
    reg add "HKLM\SOFTWARE\Classes\Word.Application.16\CLSID" /ve /d "{000209FF-0000-0000-C000-000000000046}" /f
    echo    Da dang ky thu cong xong.
)

echo [3/3] Kiem tra lai...
reg query "HKLM\SOFTWARE\Classes\Word.Application\CLSID" 2>nul
echo.
echo ============================================
echo   HOAN TAT! Hay dong cua so nay.
echo   Sau do quay lai Antigravity de tiep tuc.
echo ============================================
pause
