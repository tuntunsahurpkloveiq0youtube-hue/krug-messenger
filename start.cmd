@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem == Settings (uncomment to change) ==
rem set PORT=3210
rem set FRIENDS_CODE=secret
rem set KRUG_DATA=D:\krug-data

set "NODE="
where node >nul 2>nul
if not errorlevel 1 set "NODE=node"

if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"

if not defined NODE goto nonode

"%NODE%" server.mjs
if errorlevel 1 goto failed
exit /b 0

:nonode
echo.
echo   Node.js not found.
echo   Install Node.js 18+ from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:failed
echo.
echo   Server stopped with an error - see the messages above.
echo.
pause
exit /b 1
