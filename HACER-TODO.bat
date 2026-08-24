@echo off
chcp 65001 >nul
cd /d "%~dp0"
title LunaticoIA - Preparar y guardar

echo.
echo ================================================
echo   LunaticoIA - Preparar y guardar todo
echo ================================================
echo.
echo Esto hace dos cosas:
echo   1. Instala las librerias que faltan (nodemailer)
echo   2. Guarda el codigo en un repositorio local
echo.
echo No toca Railway ni la web que esta en linea.
echo No puede romper nada de lo que ya funciona.
echo.
echo Carpeta: %CD%
echo.
echo ------------------------------------------------
echo  PASO 1 de 2 - Instalando dependencias
echo ------------------------------------------------
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [AVISO] No encuentro npm. Me salto este paso.
  echo Si hace falta, instala Node.js desde https://nodejs.org
  echo.
  goto :git
)

call npm install
if errorlevel 1 (
  echo.
  echo [AVISO] La instalacion fallo. Sigo con el guardado igual,
  echo         que es lo importante. Copiale el error a Claude.
  echo.
) else (
  echo.
  echo   Dependencias listas.
  echo.
)

:git
echo ------------------------------------------------
echo  PASO 2 de 2 - Guardando el codigo
echo ------------------------------------------------
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No encuentro git en este equipo.
  echo Instalalo desde https://git-scm.com y vuelve a ejecutar esto.
  echo.
  pause
  exit /b 1
)

if not exist ".git" (
  echo Creando el repositorio...
  git init
  git branch -M main
  git config user.name "LunaticoIA"
  git config user.email "lunatico@ia.dev"
  echo.
)

git add -A
git commit -m "Verificacion de correo y recuperacion de contrasena" >nul 2>nul

echo Historial guardado:
echo.
git --no-pager log --oneline -10
echo.
echo ------------------------------------------------
echo Archivos bajo control de versiones:
git --no-pager ls-files ^| find /c /v ""
echo ------------------------------------------------
echo.
echo ================================================
echo   LISTO
echo.
echo   Tu codigo ya esta versionado en esta carpeta.
echo   Si algo se borra o se corrompe, se recupera.
echo.
echo   Todavia NO esta en GitHub. Para eso hace falta
echo   decidir a que repositorio va: escribile a Claude
echo   y te pasa el paso siguiente.
echo ================================================
echo.
pause
