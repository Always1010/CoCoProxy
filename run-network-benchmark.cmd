@echo off
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. No software will be installed.
  pause
  exit /b 1
)
where curl.exe >nul 2>nul
if errorlevel 1 (
  echo curl.exe was not found. No software will be installed.
  pause
  exit /b 1
)
node.exe "%~dp0scripts\network-benchmark.mjs" --interactive %*
set "benchmark_exit=%errorlevel%"
echo.
pause
exit /b %benchmark_exit%
