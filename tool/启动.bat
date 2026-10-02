@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
where node >nul 2>&1
if errorlevel 1 (
  echo 找不到 Node.js。请安装 Node.js 22 或更新版本后重试。
  pause
  exit /b 1
)
node "%~dp0launcher.js"
if errorlevel 1 (
  pause
  exit /b 1
)
exit /b 0
