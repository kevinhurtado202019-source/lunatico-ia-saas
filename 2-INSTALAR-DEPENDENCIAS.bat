@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo ================================================
echo   LunaticoIA - Instalar dependencias
echo ================================================
echo.
echo Esto descarga las librerias que necesita el
echo servidor, incluida 'nodemailer', que es la nueva.
echo Puede tardar uno o dos minutos.
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No encuentro npm en este equipo.
  echo Instala Node.js desde https://nodejs.org y vuelve a intentarlo.
  echo.
  pause
  exit /b 1
)

echo Carpeta: %CD%
echo.
call npm install

if errorlevel 1 (
  echo.
  echo ================================================
  echo   Algo fallo en la instalacion.
  echo   Copiame el texto de arriba y lo revisamos.
  echo ================================================
  echo.
  pause
  exit /b 1
)

echo.
echo ================================================
echo   Dependencias instaladas.
echo.
echo   Ahora se creo package-lock.json, que tambien
echo   hay que guardar: ejecuta 1-GUARDAR-EN-GIT.bat
echo ================================================
echo.
pause
