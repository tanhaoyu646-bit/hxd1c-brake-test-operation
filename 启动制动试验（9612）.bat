@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=9612
set PY=C:\Users\Tan\.workbuddy\binaries\python\versions\3.13.12\python.exe
if not exist "%PY%" set PY=python

echo ============================================================
echo   HXD1C 列车自动制动机试验  ·  本地实训服务
echo ============================================================
echo.
echo   电脑端（推荐）:  http://localhost:%PORT%/index.html
echo.
echo   手机端（同一 WiFi，横屏）:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /i "IPv4"') do (
  setlocal enabledelayedexpansion
  set "IP=%%a"
  set "IP=!IP: =!"
  echo       http://!IP!:%PORT%/index.html
  endlocal
)
echo.
echo   可选参数（直接在地址后追加，可叠加）:
echo       ?test=full          全部试验（感度试验 + 安定试验）
echo       ?type=passenger     按客车公式算排风时间（默认货车）
echo       ?cars=48            编组辆数（20/30/40/48/60，默认 30）
echo       ?debug=1            保压与排风均加速（开发调试用）
echo       ?scenario=short     排风时间过短（尾部响应迟缓）
echo       ?scenario=long      排风时间过长
echo       ?scenario=leak      保压漏泄超限
echo       ?scenario=exam      考核抽考（随机抽一种，考试中不告知）
echo.
echo   例: http://localhost:%PORT%/index.html?test=full^&debug=1
echo.
echo   按 Ctrl+C 停止服务
echo ============================================================
"%PY%" -m http.server %PORT% --bind 0.0.0.0
pause
