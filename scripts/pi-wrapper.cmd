@echo off
setlocal
node "%~dp0pi-wrapper.mjs" %*
exit /b %ERRORLEVEL%
