@echo off
rem Starts Singing Helper on http://127.0.0.1:8000/ and opens it in your browser. Close this window to stop it.
cd /d "%~dp0"
set PORT=8000
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python was not found. Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^), then run this again.
  pause
  exit /b 1
)
rem open the page once the server has had a moment to start
start "" /min cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:%PORT%/"
echo Singing Helper: http://127.0.0.1:%PORT%/   (use 127.0.0.1, not localhost, for Spotify)
rem tools\server.py also turns on "Make notes from audio" when its Python packages are installed
%PY% tools\server.py --port %PORT%
pause
