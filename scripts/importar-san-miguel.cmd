@echo off
setlocal
cd /d "%~dp0.."

if not exist "private-imports\san-miguel.xlsx" (
  echo No se encontro private-imports\san-miguel.xlsx
  echo Copia la carpeta private-imports incluida en la actualizacion.
  pause
  exit /b 1
)

echo Importando miembros aprobados de San Miguel...
node --env-file-if-exists=.env scripts\import-members.mjs "private-imports\san-miguel.xlsx" san_miguel
if errorlevel 1 (
  echo.
  echo La importacion no pudo completarse. La base de datos no fue modificada parcialmente.
  pause
  exit /b 1
)

echo.
echo Importacion completada. Puedes ejecutar start.cmd.
pause
