@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================
echo    MISTWOOD ONLINE MULTIPLAYER - LOCAL SERVER
echo ================================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 설치되어 있지 않습니다.
  echo https://nodejs.org 에서 Node.js LTS를 설치한 뒤 다시 실행해 주세요.
  pause
  exit /b 1
)
echo 서버를 시작합니다. 이 창을 닫으면 온라인 게임 서버도 종료됩니다.
echo 내 컴퓨터 접속 주소: http://localhost:3000
echo 같은 Wi-Fi 친구 접속: 이 컴퓨터의 내부 IP 주소와 :3000
node server.js
pause
