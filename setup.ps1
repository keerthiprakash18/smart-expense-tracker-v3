$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "[1/5] Preparing Django virtual environment..."
Set-Location "$Root\backend"
if (-not (Test-Path "venv\Scripts\python.exe")) {
  py -3 -m venv venv
}
& ".\venv\Scripts\python.exe" -m pip install --upgrade pip
& ".\venv\Scripts\python.exe" -m pip install -r requirements.txt

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Write-Host "Created backend/.env from example."
}

Write-Host "[2/5] Applying database migrations..."
& ".\venv\Scripts\python.exe" manage.py migrate

Write-Host "[3/5] Running backend checks..."
& ".\venv\Scripts\python.exe" manage.py check

Write-Host "[4/5] Installing frontend dependencies..."
Set-Location "$Root\frontend"
npm ci
if (-not (Test-Path ".env.local")) {
  Copy-Item ".env.example" ".env.local"
  Write-Host "Created frontend/.env.local from example."
}

Write-Host "[5/5] Setup complete."
Write-Host "Run .\\start.ps1 from the project root, or use VS Code task: Start Full Stack."
