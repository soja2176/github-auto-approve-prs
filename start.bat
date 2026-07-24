@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

echo Esperando a que Docker Desktop este listo...
set /a intentos=0

:waitloop
docker info >nul 2>&1
if not errorlevel 1 goto dockerlisto
set /a intentos+=1
if !intentos! GEQ 20 (
  echo Docker no respondio despues de 60 segundos. Abri Docker Desktop manualmente y volve a correr este script.
  exit /b 1
)
timeout /t 3 >nul
goto waitloop

:dockerlisto
echo Docker listo. Levantando el proyecto...
docker compose up -d
echo Listo. Dashboard en http://localhost:3000
