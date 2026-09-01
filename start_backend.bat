@echo off
setlocal

cd /d "%~dp0backend"

where python >nul 2>nul
if %errorlevel%==0 (
    echo Starting backend with 'python'...
    python -m app.main
    goto :end
)

where py >nul 2>nul
if %errorlevel%==0 (
    echo Starting backend with 'py'...
    py -m app.main
    goto :end
)

echo ERROR: Neither 'python' nor 'py' was found on PATH.
echo Please install Python from https://python.org and try again.

:end
pause
