@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ================================================
echo   LunaticoIA - Guardar el codigo en Git
echo ================================================
echo.
echo Carpeta: %CD%
echo.

REM --- Comprobar que git esta instalado ---
where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No encuentro git en este equipo.
  echo Instalalo desde https://git-scm.com y vuelve a ejecutar este archivo.
  echo.
  pause
  exit /b 1
)

REM --- Inicializar el repositorio si no existe ---
if not exist ".git" (
  echo No habia repositorio aqui. Creando uno nuevo...
  git init
  git branch -M main
  git config user.name "LunaticoIA"
  git config user.email "lunatico@ia.dev"
  echo.
) else (
  echo Ya existe un repositorio en esta carpeta.
  echo.
)

REM --- Ver que hay pendiente ---
echo ------------------------------------------------
echo Estado actual:
echo ------------------------------------------------
git status --short
echo.

REM --- Guardar todo ---
echo ------------------------------------------------
echo Guardando los cambios...
echo ------------------------------------------------
git add -A
git commit -m "Verificacion de correo y recuperacion de contrasena" 2>nul

if errorlevel 1 (
  echo.
  echo No habia nada nuevo que guardar, o el commit fallo.
  echo Si dice 'nothing to commit', esta todo guardado ya.
) else (
  echo.
  echo Cambios guardados correctamente.
)

echo.
echo ------------------------------------------------
echo Historial guardado hasta ahora:
echo ------------------------------------------------
git --no-pager log --oneline -10
echo.
echo ================================================
echo   Listo. El codigo ya esta versionado EN LOCAL.
echo.
echo   Todavia NO esta en GitHub: para eso hay que
echo   conectar un repositorio remoto. Avisame y te
echo   paso el paso siguiente.
echo ================================================
echo.
pause
