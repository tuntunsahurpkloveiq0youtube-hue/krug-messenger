@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem == Demo mail mode: the login code is printed on the screen ==
set KRUG_DEV_MAIL=1

echo.
echo   Demo mail mode is ON - letters are not sent,
echo   the login code is shown on the screen.
echo.

call "%~dp0start.cmd"
