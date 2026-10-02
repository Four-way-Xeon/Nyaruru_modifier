@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
node "%~dp0launcher.js" --stop
if errorlevel 1 pause
