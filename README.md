# Smart Expense Tracker V3

A production-oriented personal finance app built with Django REST Framework, React/Vite, PostgreSQL and Capacitor Android.

## Core finance

- Expense, income and bill tracking with account-balance updates.
- Multiple accounts and account-to-account transfers that do not count as spending.
- Search, filter and CSV export for transactions.
- Monthly dashboard, category analytics and cash-flow charts.
- Borrow/lend tracking with repayment history.
- Bills and savings goals.

## V3 features

- Automatic receipt OCR from camera photos, uploaded images and scanned PDFs.
- OCR extraction for merchant, amount, date, category, payment method, tax, GSTIN and UPI reference.
- OCR confidence, duplicate receipt detection and receipt vault.
- Smart merchant memory for repeated categorisation/payment-method choices.
- Category budgets.
- Recurring transaction rules for expenses, income and bills.
- Credit-card tracking with purchases, payments, utilization and due-day metadata.
- Custom categories.
- Financial calendar combining transactions, bills, transfers and recurring items.
- Full JSON backup/restore and CSV import.
- Notification center for bill, budget, recurring, card and security alerts.
- Smart financial insights.
- Email verification, password reset and optional authenticator 2FA.
- Optional S3-compatible receipt storage (AWS S3 / Cloudflare R2).
- Installable PWA plus Capacitor Android project for APK/AAB builds.

## Production architecture

- Frontend: Vercel (`frontend/` root).
- Backend: Railway (`backend/` root).
- Database: Railway PostgreSQL via `DATABASE_URL`.
- Receipt storage: S3-compatible storage is recommended in production.

## Windows local setup

After cloning the repository, run:

```powershell
.\setup.cmd
.\start.cmd
```

Or manually:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\setup.ps1
powershell.exe -ExecutionPolicy Bypass -File .\start.ps1
```

Frontend: `http://localhost:5173`
Backend: `http://127.0.0.1:8000`

## Production environment variables

Backend essentials:

```env
DEBUG=False
SECRET_KEY=<strong-secret>
DATABASE_URL=<postgres-url>
ALLOWED_HOSTS=.up.railway.app
CORS_ALLOWED_ORIGINS=https://<your-vercel-domain>
TIME_ZONE=Asia/Kolkata
```

Optional email verification/password reset SMTP:

```env
EMAIL_BACKEND=django.core.mail.backends.smtp.EmailBackend
EMAIL_HOST=<smtp-host>
EMAIL_PORT=587
EMAIL_HOST_USER=<smtp-user>
EMAIL_HOST_PASSWORD=<smtp-password>
EMAIL_USE_TLS=True
DEFAULT_FROM_EMAIL=Smart Expense <noreply@example.com>
```

Optional S3 / Cloudflare R2 receipt storage:

```env
AWS_STORAGE_BUCKET_NAME=<bucket>
AWS_ACCESS_KEY_ID=<access-key>
AWS_SECRET_ACCESS_KEY=<secret-key>
AWS_S3_ENDPOINT_URL=<s3-or-r2-endpoint>
AWS_S3_REGION_NAME=auto
AWS_QUERYSTRING_AUTH=True
```

Frontend production variable:

```env
VITE_API_URL=https://smart-expense-tracker-v3-production.up.railway.app
```

## Android

```powershell
cd frontend
npm run build
npx cap sync android
npx cap open android
```

Set `VITE_API_URL` before building a production APK/AAB.

## Verification

Before the V3 batch release:

- Django `manage.py check`: pass.
- `makemigrations --check --dry-run`: no model drift.
- 16 backend regression tests: pass.
- Frontend production build is validated by GitHub Actions using a clean `npm ci` environment after the single release push.

## Security

Never commit `.env`, database files, signing keys, passwords, SMTP credentials, S3/R2 secrets or API keys. Keep production secrets in Railway/Vercel environment variables.
