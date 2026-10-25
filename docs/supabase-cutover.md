# Supabase cutover — local implementation, not deployed

## Current boundary

The existing Django/Railway mode remains the default. No remote migration, GitHub
push, Vercel deployment, database deletion, data import, or credential rotation
was performed. The user wants a fresh Supabase backend, not Railway data migration.

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

## Approval-gated deployment sequence

1. Verify the selected Supabase project and inspect any existing tables. Dashboard
   "No migrations" does not prove the database contains no Django tables.
2. After approval, apply `supabase/migrations/20261025000100...00900` in order using
   the Supabase CLI migration workflow. Never apply the `supabase/tests/bootstrap.sql`
   fixtures remotely. New `tracker_*` tables do not import or remove Django tables.
3. Configure Auth site URL, confirmation/recovery redirects, and email delivery as
   described in `docs/auth-supabase.md`; do not disable confirmations merely to pass
   a test. Deploy `delete-account` with server-only credentials and allowed origins.
4. Publish a reviewed branch/PR only after permission. Set the three public build
   variables for a **Vercel preview first**; keep production unchanged.
5. On that preview create two test accounts, verify email and sign in. Create an
   expense, refresh and sign out/in. Verify it remains only in the correct account.
   Test transfers/repayment rollback, receipt upload/download, MFA and recovery.
6. Only after live checks and acceptance of the parity limits above, approve the
   production cutover. Set the same public variables and rebuild production.
   Already-installed Android builds still require an updated native build.

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
