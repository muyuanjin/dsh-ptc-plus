@echo off
setlocal

rem Double-click launcher for an isolated DSH alpha profile with this checkout installed.
set "SCRIPT_DIR=%~dp0"
set "POWERSHELL_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
if not exist "%POWERSHELL_EXE%" (
  set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
)
if not exist "%POWERSHELL_EXE%" (
  echo PowerShell was not found in its standard installation directories.
  exit /b 1
)
"%POWERSHELL_EXE%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%run-dev-dsh.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Isolated DSH development launcher failed with exit code %EXIT_CODE%.
)

if /i not "%DSH_DEV_INSTALL_NO_PAUSE%"=="1" pause
exit /b %EXIT_CODE%
