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


## Edge firewall / DDoS
- Vercel frontend: keep Vercel Firewall/DDoS protections enabled; use rate-limit or challenge rules if abusive traffic appears.
- Railway API: the app has application-level throttling and request guards. During an active layer-7 attack, Railway's Under Attack Mode can be enabled from the service Edge settings.
- If a custom API domain is introduced later, placing Cloudflare WAF in front of it adds configurable managed WAF rules and bot controls.
- Keep PostgreSQL private; do not expose a public TCP proxy unless it is temporarily required for administration.


## One-time full database reset
Run only when a complete clean slate is intentionally required:

```bash
python manage.py reset_production_data --confirm RESET_ALL_DATA
```

This uses Django flush: it removes application/auth/token data but keeps the database schema and migrations. After a reset, all users must register again and all old browser sessions are invalid.

## Authentication stability
Set a persistent Railway `SECRET_KEY` environment variable. Gunicorn runs with `--preload` so all workers share the same Django settings instance, but a persistent environment secret is still required so sessions/tokens survive service restarts and deployments.
