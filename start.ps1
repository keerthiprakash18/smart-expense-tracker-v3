$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path "$Root\backend\venv\Scripts\python.exe")) {
  Write-Host "Backend environment not found. Run .\\setup.ps1 first." -ForegroundColor Yellow
  exit 1
}
if (-not (Test-Path "$Root\frontend\node_modules")) {
  Write-Host "Frontend dependencies not found. Run .\\setup.ps1 first." -ForegroundColor Yellow
  exit 1
}

Write-Host "Starting Django API on http://127.0.0.1:8000"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root\backend'; .\venv\Scripts\python.exe manage.py runserver 127.0.0.1:8000"

Write-Host "Starting React/Vite on http://localhost:5173"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$Root\frontend'; npm run dev"

Write-Host "Smart Expense Tracker is starting. Open http://localhost:5173"
