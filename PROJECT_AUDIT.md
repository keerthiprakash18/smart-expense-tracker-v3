# Smart Expense Tracker V2 — Product Upgrade Audit

## Architecture upgrade

The old frontend concentrated most behavior inside one very large Dashboard component. V2 replaces that with a maintainable product structure:

- `AppShell` — desktop sidebar, mobile bottom navigation, account controls and sync.
- `FinanceContext` — shared profile/accounts/transactions/summary state and CRUD operations.
- `ThemeContext` — persistent user-selectable themes.
- Dedicated pages for Overview, Transactions, Add/Edit, Analytics, Money Hub and Profile/Settings.
- Shared UI primitives for cards, metrics, progress, empty states and transaction rows.

## Product capabilities added / completed

- Premium responsive fintech UI with Midnight, Ocean, Emerald and Gold themes.
- Separate workflow screens instead of an overcrowded single dashboard.
- Real transaction create/edit/delete connected to account-balance logic.
- Search/filter/export transaction ledger.
- Monthly budget health and category/cash-flow analytics.
- Image/PDF receipt scan entry point.
- Money Hub backend APIs + UI:
  - borrowed/lent money,
  - repayment history,
  - upcoming bills,
  - savings goals.
- Installable PWA configuration while retaining Capacitor Android support.
- `setup.cmd` and `start.cmd` Windows launchers to avoid PowerShell signature-policy friction.
- GitHub Actions CI for Django checks/tests and a fresh Linux frontend production build.

## Verification performed before push

- Python source compile: pass.
- Django `manage.py check`: pass.
- `makemigrations --check --dry-run`: no model drift.
- Backend regression suite: 7/7 tests pass.
- Frontend JS/JSX parse: 20 files, 0 syntax errors.
- Frontend relative import scan: 0 missing imports.
- Local Linux Vite build cannot reuse the user-uploaded Windows `node_modules` because its Rolldown native binding is Windows-specific. The repository CI intentionally performs a clean `npm ci` on Linux to validate the real production build.
