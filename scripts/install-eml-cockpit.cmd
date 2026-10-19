@echo off
rem Install the EML Cockpit on Windows: double-click this file. It runs the
rem installer of the newest release (install.ps1) in PowerShell, which needs
rem nothing installed and no admin rights. With EML_FROM set (a folder with
rem release assets, as in CI) it runs the install.ps1 next to this file instead.
title EML Cockpit installer
if defined EML_FROM (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm https://github.com/EpistemicLabs/eml/releases/latest/download/install.ps1 | iex"
)
set EML_RESULT=%ERRORLEVEL%
echo.
if not "%EML_RESULT%"=="0" echo The installation did not finish. The message above says why.
rem Keep the window open so the result can be read; CI sets EML_NO_PAUSE.
if not defined EML_NO_PAUSE pause
exit /b %EML_RESULT%
