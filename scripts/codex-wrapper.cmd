@echo off
setlocal
node "%~dp0codex-wrapper.mjs" %*
exit /b %ERRORLEVEL%
