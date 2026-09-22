# Production Readiness

## Automated checks
- Django system check and migration drift check
- Backend API tests
- Frontend production build
- Production Django deployment check
- Python dependency consistency check
- npm production high/critical vulnerability gate
- Dependabot weekly dependency update checks

## Required Railway settings
- DEBUG=False
- SECRET_KEY=<strong random secret>
- DATABASE_URL=<Railway PostgreSQL reference>
- ALLOWED_HOSTS=.up.railway.app
- CORS_ALLOWED_ORIGINS=https://smart-expense-tracker-v3.vercel.app,https://localhost
- ENABLE_ADMIN=False
- EMAIL_SECURITY_ENABLED=False
- TIME_ZONE=Asia/Kolkata

## Storage
For permanent receipt retention, configure S3-compatible storage such as Cloudflare R2 or S3 with the AWS_* environment variables. Container-local media storage is not durable across all deployment scenarios.

## Operations
- Keep PostgreSQL backups enabled in the hosting plan.
- Review Railway/Vercel logs for 5xx spikes.
- Rotate compromised secrets immediately.
- Keep Dependabot updates reviewed and merged.
- Test restore/export flows before major releases.

## Release smoke test
Register -> Login -> Add account -> Income -> Expense -> Edit/Delete -> Transfer -> Recurring -> Budget -> Receipt OCR -> Receipt Vault -> Planner -> Notifications -> Backup export -> 2FA -> Recovery-code login -> Logout -> Account deletion (test account only).
