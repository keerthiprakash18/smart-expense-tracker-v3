# Smart Expense Tracker V3 — Release Audit

## Release strategy

This V3 batch is prepared as one atomic production release so Railway and Vercel receive one deployment trigger instead of many incremental pushes.

## Implemented feature set

1. Recurring transaction engine.
2. Account-to-account transfers.
3. Category-wise monthly budgets.
4. Receipt Vault.
5. Bill reminders through the notification center.
6. Smart merchant memory for OCR categorisation/payment method.
7. Credit-card tracking with purchase/payment history.
8. Custom categories.
9. Financial calendar.
10. JSON backup/restore plus CSV import/export.
11. Password reset, email verification and authenticator 2FA.
12. Optional S3-compatible receipt storage for AWS S3 / Cloudflare R2.
13. Notification center.
14. Smart financial insights.
15. Android/Capacitor production structure.

## OCR upgrade

- Camera capture, image upload and PDF upload.
- Automatic scan immediately after capture/upload.
- Tesseract preprocessing with multiple page-segmentation modes and thresholds.
- Image-only/scanned PDF fallback through PyMuPDF rendering + OCR.
- Merchant, amount, date, category, payment method, tax, GSTIN and UPI reference extraction.
- OCR confidence persisted with the transaction.
- Duplicate receipt warning.
- Receipt image/PDF retained with the transaction and exposed in Receipt Vault.

## Architecture

- Existing Django REST/JWT backend preserved and extended.
- V3 APIs isolated under `/api/v3/` where appropriate.
- Existing transaction/account ledger behavior preserved.
- Planner groups budgets, recurring rules, transfers, cards, custom categories, calendar and backup workflows.
- Dedicated Receipt Vault and Notifications pages.
- User isolation remains enforced at queryset/API level.

## Verification before release

- `python manage.py check`: pass.
- `python manage.py makemigrations --check --dry-run`: no changes detected.
- Existing core regression group: 8/8 pass.
- New V3 regression group: 8/8 pass.
- Total backend tests: 16/16 pass.
- GitHub CI is configured to run a clean frontend `npm ci` + `npm run build` and backend checks/tests on the single release push.

## Repository hygiene

The release removes the accidentally tracked `pydeps/` dependency copy and keeps generated/runtime content out of Git:

- `pydeps/`
- `backend/venv/`
- `backend/db.sqlite3`
- `backend/media/`
- `backend/staticfiles/`
- `frontend/node_modules/`
- `frontend/dist/`
- Android build/cache output
- environment secret files
