@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22.9 或更高版本，再重新启动。
  pause
  exit /b 1
)
node scripts\check-node.mjs
if errorlevel 1 goto failed
if not exist "node_modules\next\package.json" (
  call npm ci --no-audit --no-fund
  if errorlevel 1 goto failed
)
if not exist ".next\BUILD_ID" (
  call npm run build
  if errorlevel 1 goto failed
)
node scripts\start.mjs
if errorlevel 1 goto failed
start "" "http://127.0.0.1:3210"
exit /b 0
:failed
echo 启动未完成。请查看上面的错误，或检查 .data\server.log。
pause
exit /b 1
