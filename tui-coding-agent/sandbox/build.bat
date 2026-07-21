@echo off
rem 编译沙箱辅助工具 sandbox-helper.exe
rem 使用 HanaWindowsSandboxHelper (https://github.com/cxxsucks/HanaWindowsSandboxHelper)
rem
rem 需要 Visual Studio 2022 Build Tools
rem   "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

setlocal enabledelayedexpansion

set "CURRENT_DIR=%~dp0"
set "PROJECT_DIR=%CURRENT_DIR%.."
set "OUTPUT_DIR=%PROJECT_DIR%\bin"

if not exist "%OUTPUT_DIR%" mkdir "%OUTPUT_DIR%"

echo Compiling sandbox-helper.exe from HanaWindowsSandboxHelper...

cl /nologo /O2 /EHsc /utf-8 /W3 /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN ^
    "%CURRENT_DIR%main.cpp" ^
    /Fo"%OUTPUT_DIR%\sandbox-helper.obj" ^
    /Fe"%OUTPUT_DIR%\sandbox-helper.exe" ^
    /link advapi32.lib user32.lib kernel32.lib

if !ERRORLEVEL! equ 0 (
    echo.
    echo ============================================
    echo Build successful!
    echo Output: %OUTPUT_DIR%\sandbox-helper.exe
    echo ============================================
) else (
    echo.
    echo ============================================
    echo Build failed with error code !ERRORLEVEL!
    echo.
    echo Make sure Visual Studio build tools are available.
    echo Run the appropriate vcvars batch file first, e.g.:
    echo   "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
    echo ============================================
)

endlocal
