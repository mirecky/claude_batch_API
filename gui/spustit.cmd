@echo off
rem Dvojklik spusti aplikaciu. Prve spustenie nainstaluje Electron (potrebny Node.js).
cd /d "%~dp0"
if not exist node_modules\electron\dist (
  echo Prve spustenie - instalujem Electron, chvilu to potrva...
  call npm install || (echo. & echo Instalacia zlyhala. Je nainstalovany Node.js? https://nodejs.org & pause & exit /b 1)
)
call npm start
