# Smart Expense Tracker V2

A production-oriented personal finance app built with Django REST, React/Vite and Capacitor Android.

## V2 product experience

- Premium responsive app shell: desktop sidebar + mobile bottom navigation.
- Separate screens for Overview, Transactions, Add/Edit, Analytics, Money Hub and Profile/Settings.
- Custom themes: Midnight, Ocean, Emerald and Gold.
- Expense, income and bill tracking with real account-balance updates.
- Receipt image/PDF OCR flow with duplicate detection.
- Analytics for monthly cash flow and category spending.
- Money Hub APIs and UI for borrowed/lent money, repayment history, bills and savings goals.
- JWT authentication with automatic access-token refresh.
- User-scoped APIs and account isolation.
- Capacitor Android project retained for APK/AAB builds.

## Windows — easiest setup

After cloning or extracting the project, double-click:

1. `setup.cmd` — creates the Python environment, installs dependencies, runs migrations/checks and installs frontend packages.
2. `start.cmd` — starts Django on `http://127.0.0.1:8000` and Vite on `http://localhost:5173`.

The `.cmd` launchers use a process-only PowerShell execution-policy bypass, so downloaded unsigned `.ps1` files are not blocked.

## Manual setup

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\setup.ps1
powershell.exe -ExecutionPolicy Bypass -File .\start.ps1
```

## Android

```powershell
cd frontend
npm run build
npx cap sync android
npx cap open android
```

Set `VITE_API_URL` to the deployed backend URL before a production Android/web build.

## Verification

Backend:

```powershell
cd backend
.\venv\Scripts\python.exe manage.py test expenses
.\venv\Scripts\python.exe manage.py check
```

Current backend regression suite covers authentication/profile, transaction ledger consistency, user isolation, dashboard summary, Money Hub repayments, bills and savings-goal isolation.

## Security

Never commit `.env`, `.env.local`, `.env.production`, database files, signing keys, passwords or API keys. Production secrets belong in the hosting provider environment.
