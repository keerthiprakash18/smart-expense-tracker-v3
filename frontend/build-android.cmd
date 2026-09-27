@echo off
setlocal
cd /d "%~dp0"

echo.
echo ===============================================
echo   Smart Expense Tracker - Android APK Builder
echo ===============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  exit /b 1
)

call npm ci
if errorlevel 1 exit /b 1

set VITE_API_URL=https://smart-expense-tracker-v3-production.up.railway.app
call npm run build
if errorlevel 1 exit /b 1

call npx cap sync android
if errorlevel 1 exit /b 1

cd android
call gradlew.bat assembleDebug
if errorlevel 1 exit /b 1

cd ..
if not exist release mkdir release
copy /Y "android\app\build\outputs\apk\debug\app-debug.apk" "release\SmartExpenseTracker.apk" >nul

echo.
echo ===============================================
echo   APK READY
echo   %CD%\release\SmartExpenseTracker.apk
echo ===============================================
echo.
endlocal
