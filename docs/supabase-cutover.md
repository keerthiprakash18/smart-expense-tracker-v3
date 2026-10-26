# Supabase cutover — deployed Supabase mode

## Current boundary

The existing Django/Railway mode remains the default for local builds. The fresh
Supabase backend is deployed for the Vercel project below. The existing Railway
database, accounts, data and deployment were not migrated, deleted or modified.

Deployment receipts (October 26, 2026):

- Supabase project: `ipaywszupvkckafzgite` (`smart-expense-tracker`)
- Vercel production: `https://smart-expense-tracker-v3.vercel.app`
- Vercel production deployment: `dpl_AKRbByHPyfrxA2FAyQpz1P1cVCLb`
- Vercel preview deployment: `https://smart-expense-tracker-v3-ggkhpm4ym-luciferkp.vercel.app`
- Git branch/commit: `feat/supabase-vercel-cutover` / `2211406`

Opt in to the new backend at frontend build time:

```env
VITE_BACKEND_PROVIDER=supabase
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLIC_PUBLISHABLE_KEY
```

Never put a database URL, service role, secret key, or account password in a
`VITE_` variable. The CSP in `frontend/vercel.json` currently allows the user's
selected Supabase project origin. If the target changes, update this exact origin
as well; do not add a wildcard. WASM compilation is allowed for local receipt OCR,
not general `unsafe-eval`.

## Implemented

- SDK email/password Auth, confirmation/recovery, persisted sessions, MFA gating.
- Existing app API facade routes to Supabase without a Railway fallback in the
  opted-in mode. Protected CRUD uses both explicit owner scopes and database RLS.
- Accounts, expenses/income/bills, transfers, savings, debts/repayments, categories,
  budgets, cards/activities, notifications, calendar and profile preferences.
- SQL totals over the complete ledger, not the first PostgREST page. Collection
  reads use keyset paging and explicitly reject more than 20,000 rows rather than
  return silently incomplete data.
- Atomic balance maintenance, user isolation, MFA checks, command confirmation,
  idempotency and same-user-only backup restore in versioned SQL migrations.
- Private receipt files, signed display URLs, browser-only image/PDF OCR. Receipt
  contents are not sent to an external OCR provider.
- In-app English/Tamil/Tanglish assistant commands, preferences and notes.
- Local text category learning and recurring-payment candidates; no external LLM.

## Deliberate differences / incomplete parity

- **Native background wake is not ported.** It requires a scoped-token/Edge bridge
  and an Android release. Supabase mode blocks starting it and stops any legacy
  native service when its status is queried. In-app voice remains available.
- **Offline scheduled finance jobs are not deployed.** Due recurring rules run
  atomically when the workspace refreshes. No Railway cron is contacted.
- Profile email/username changes are refused rather than bypassing email
  confirmation. Email is the Supabase login identity; display-name/preferences
  edits work. Legacy Django recovery codes are not compatible with Supabase MFA.
- OCR uses a bundled English model, has page/size/time limits, and always requires
  review. Duplicate-receipt checking is explicitly not performed by the OCR module.
- Storage objects are not included in JSON backups. Signed receipt URLs last five
  minutes; refresh to renew. On ambiguous save failures, uploaded private objects
  are retained rather than risking deletion of a successfully saved receipt.
- Account/card/debt deletion refuses dependent history, rather than cascading
  financial history silently. Existing Django code is retained unchanged.
- Account deletion requires deploying the `delete-account` Edge Function and its
  exact allowed origins. Full Auth/Storage/Edge HTTP behavior must be checked live.

## Completed remote setup

1. Nine versioned migrations were applied to the Supabase project in order. Local
   test fixtures were not applied remotely; the migrations create the new
   `tracker_*` schema without importing or removing Django tables.
2. The `delete-account` Edge Function was deployed. Its server-only secrets are
   configured, and `AUTH_ALLOWED_ORIGINS` includes the production and preview
   origins. Gateway JWT verification is disabled for this function because the
   handler performs the Auth-validated token checks and origin policy itself. An
   OPTIONS request from production returned `204` with the expected CORS headers;
   unauthenticated production POST returned `401`, and a disallowed origin
   returned `403`.
3. Supabase Auth has Email enabled and Confirm email enabled.
4. Supabase Auth Site URL is the production Vercel origin. The production and
   preview login/recovery redirect URLs are allowlisted.
5. Vercel Production and Preview contain only the public Supabase build settings
   required by the browser: provider, project URL and publishable key. The
   service-role/secret key was not placed in a `VITE_*` variable.
6. The reviewed implementation was committed and pushed to GitHub, then deployed
   Preview-first and promoted to the production domain.

## Live verification status

- Production and Preview both render the Supabase-mode login screen.
- Production Vercel deployment completed with `READY` status and the production
  alias was assigned.
- Local security, migration, finance, Auth and browser suites passed as listed
  below.
- A real email signup/login/expense round-trip is still pending because it needs a
  user-controlled mailbox confirmation. Mocked browser tests are not evidence of
  that live Auth flow.
- Already-installed Android builds still require an updated native build.

## Verification commands

From the repository root:

```sh
python -u supabase/tests/run_local.py
node --test supabase/tests/delete-account.test.mjs
```

From `frontend`:

```sh
node --test tests/supabase-auth.test.js tests/supabase-assistant-parser.test.js tests/supabase-assistant.test.js tests/receipt-ocr.test.js tests/supabase-finance.test.js
npx playwright test --config tests/supabase-auth.playwright.config.js
npm run test:ocr:browser
npm run build
npm run lint
```

The real PostgreSQL suite passed 445 assertions including concurrency, isolation,
MFA and restore rollback. The Auth/finance UI tests use mocked Supabase HTTP; they
are **not evidence of a live deployed connection**. OCR browser tests run actual
bundled Tesseract/PDF.js against synthetic documents. Production build passed;
large-chunk warnings and two pre-existing Assistant.jsx lint warnings remain.
