# Supabase backend contract

This is a **fresh-data replacement backend**. Apply the versioned files in
`supabase/migrations/` using the Supabase migration workflow. There is no Django
import, and these migrations do not modify Django, Railway, or their databases.

## Frontend integration essentials

- There are **17 app tables**: 16 portable app-data tables and the RPC-managed
  `tracker_assistant_commands` execution history. All use the `public.tracker_`
  prefix and explicit owner-only RLS plus restrictive session/MFA policies.
  Commands allow client SELECT only; their writes go through assistant RPCs.
- Except profiles, every table has `id bigint GENERATED ALWAYS AS IDENTITY` and
  `user_id uuid NOT NULL DEFAULT auth.uid()`. Omit both in inserts. Treat bigint
  IDs as opaque identifiers (strings are safe when calling PostgREST).
- `tracker_profiles.id` is the Supabase Auth user UUID. Read/update it with
  `.eq('id', user.id)`. Profiles are created by the Auth insert trigger; clients
  cannot insert profiles or change recorded legal acceptance timestamps.
- Omit `created_at`, `updated_at`, and all derived counters from writes. Column
  grants deliberately reject full-row updates that include protected columns.
- Names of relations are Django field names: `account`, `debt`, `from_account`,
  `to_account`, `linked_account`, `card` (not their `_id` variants).
- `balance` (accounts) and `outstanding` (cards) are allowed **only on INSERT**
  as opening values. Updates are maintained by ledger triggers. To correct a
  balance, create/revise/delete an expense/income or card adjustment activity.
  Do not have the frontend also increment/decrement these counters.
- Debt `amount_paid`, debt `status`, and recurring `last_run` are server-managed.
- Decimal money is `NUMERIC(12,2)`, finite only. Transaction amounts must be
  positive; budgets/current savings/card outstanding must be nonnegative.
  Account balances may be negative, matching the existing overdraft behavior.
- Date columns reject infinity; normal PostgreSQL date validation applies.
  Transaction `time` accepts 24-hour `HH:MM` or `HH:MM:SS`.

## Tables and columns

The lists below omit common `id` and `user_id` unless stated. `created_at` is a
server timestamp wherever listed; `updated_at` is refreshed on every update.
Nullable columns are marked `?`. Defaults match the Django models unless the
security/finance differences below say otherwise.

- **tracker_profiles**: `id uuid`, `name`, `phone?`, `country='India'`,
  `currency='₹'`, `monthly_budget=45000`, `savings_goal=100000`, `dark_mode=true`,
  `budget_alerts=true`, `bill_reminders=true`, `terms_accepted_at?`,
  `privacy_accepted_at?`. There is no `user_id` on this table.
- **tracker_accounts**: `name='Primary Account'`, `account_type='BANK'`,
  `balance=0`, `created_at`. Types: BANK, UPI, CASH, CARD, WALLET, CUSTOM.
- **tracker_expenses**: `account?`, `title='Transaction'`, `amount`,
  `transaction_type='EXPENSE'`, `category='General'`, `payment_method='UPI'`,
  `date=current_date`, `time='12:00'`, `notes?`, `is_recurring=false`,
  `receipt_image?`, `ocr_confidence?` (0–100), `created_at`.
  Types: EXPENSE, INCOME, BILL. Transfers belong only in `tracker_transfers`.
- **tracker_bills**: `title`, `amount`, `due_date`,
  `category='Bills & Utilities'`, `is_paid=false`, `is_recurring=true`, `created_at`.
- **tracker_savings_goals**: `name`, `target_amount`, `current_amount=0`,
  `target_date?`, `icon='🎯'`, `created_at`. Current cannot exceed target.
- **tracker_money_debts**: `direction` (BORROWED/LENT), `person_name`, `amount`,
  `amount_paid=0`, `transaction_date=current_date`, `due_date?`, `purpose=''`,
  `notes?`, `status='PENDING'`, `created_at`, `updated_at`.
- **tracker_debt_payments**: `debt`, `amount`, `payment_date=current_date`,
  `notes?`, `created_at`.
- **tracker_transfers**: `from_account`, `to_account`, `amount`,
  `date=current_date`, `notes=''`, `created_at`.
- **tracker_category_budgets**: `category`, `amount`, `period='MONTHLY'`,
  `active=true`, `created_at`, `updated_at`. Unique user/category/period.
- **tracker_recurring_rules**: `title`, `amount`, `transaction_type='EXPENSE'`,
  `category='General'`, `account?`, `payment_method='UPI'`, `frequency='MONTHLY'`,
  `interval=1` (1–365), `next_run=current_date`, `end_date?`, `active=true`,
  `last_run?`, `notes=''`, `created_at`, `updated_at`.
  Frequencies: DAILY, WEEKLY, MONTHLY, YEARLY. Types: EXPENSE, INCOME, BILL.
- **tracker_categories**: `name`, `category_type='EXPENSE'` (EXPENSE/INCOME),
  `color='#0A84FF'`, `icon='Tag'`. Account/category names are case-insensitively
  unique per user after trimming whitespace.
- **tracker_credit_cards**: `name`, `last4=''` (empty or four ASCII digits),
  `credit_limit=0`, `outstanding=0`, `statement_day=1`, `due_day=20`
  (both 1–28), `linked_account?`, `active=true`, `created_at`.
- **tracker_credit_card_activities**: `card`, `activity_type`
  (PURCHASE/PAYMENT/ADJUSTMENT), `amount`, `date=current_date`, `notes=''`
  (max 240 characters), `created_at`, plus explicit accounting fields:
  `payment_account?`, `adjustment_direction=1` (1 or -1).
  PAYMENT requires an owned `payment_account`; other types forbid it.
  Only ADJUSTMENT may set `adjustment_direction=-1`.
- **tracker_notifications**: `kind='SYSTEM'`
  (BILL/BUDGET/RECURRING/CARD/SECURITY/SYSTEM), `title`, `message`, `due_date?`,
  `action_url=''`, `is_read=false`, `dedupe_key?`, `created_at`.
  Unique user/dedupe_key; null allows multiple notifications.
- **tracker_assistant_profiles**: `assistant_name='Nova'`, `language='AUTO'`
  (AUTO/EN/TA), `voice_responses=true`, `personality='FRIENDLY'`
  (FRIENDLY/PROFESSIONAL/MINIMAL), `confirmation_mode='SMART'` (SMART/ALWAYS),
  `quick_add=false`, `background_wake_enabled=false`, `created_at`, `updated_at`.
  One row per user, created during signup.
- **tracker_assistant_notes**: `content`, `source='TEXT'`
  (VOICE_WAKE/VOICE_APP/TEXT), `is_done=false`, `reminder_at?`, `created_at`,
  `updated_at`.
- **tracker_assistant_commands**: `client_request_id uuid`, `intent`,
  `safe_payload jsonb`, `result_payload jsonb`, `confidence numeric(4,3)`, `status`,
  `requires_confirmation`, `response_text`, `fingerprint`, `transaction? bigint`,
  `executed_at?`, `created_at`, `updated_at`. Unique `(user_id,client_request_id)`.
  Statuses: PENDING, NEEDS_CLARIFICATION, COMPLETED, CANCELLED, FAILED.
  `(user_id,transaction)` references the owned expense; deleting the expense sets
  only `transaction` to null. No client INSERT/UPDATE/DELETE grant, including for
  its owner: clients cannot forge outcomes or erase idempotency records.

Presentation fields from Django serializers (`account_name`, `remaining_amount`,
`progress_percent`, `available_credit`, `utilization_percent`, budget `spent` and
`percent`) are not stored columns. Join related tables or calculate from the
owner-scoped rows. Debt remaining is `amount - amount_paid`; overdue presentation
should consider `due_date < today && remaining > 0`, since stored status refreshes
on debt/repayment mutations rather than a midnight scheduler.

## Atomic finance behavior

INSERT/UPDATE/DELETE on expenses reverses the old ledger effect and applies the
new one in the same transaction. INCOME adds; EXPENSE and BILL subtract. A null
account has no balance effect. Changing amount/type/account is supported.

Transfers are a single row with two atomic balance effects. Both account IDs must
belong to the owner and must differ. Editing/deleting the row reverses the old
legs; never add a corresponding TRANSFER expense.

Debt payments maintain `amount_paid` and status. Overpayment and shrinking a debt
below paid principal are rejected. Editing/deleting payments updates counters.
Debt payments do not move bank balances, matching the Django repayment model.

Card purchases add outstanding. Adjustments apply their explicit sign. Payments
subtract outstanding and debit their payment account together. Overpayments are
rejected rather than silently clamped. Editing/deleting an activity reverses its
old effects. Deleting a purchase that would make outstanding negative is rejected;
reverse the dependent payment first. Card payments are not additionally inserted
into expenses, preserving the existing accounting behavior.

`tracker_bills.is_paid` is a planning flag; changing it does not create a ledger
expense. Savings goals also do not move bank balances. These match the original
Django behavior.

All financial references use `(user_id, related_id)` composite FKs. Referenced
accounts/cards/debts cannot be deleted while history/rules reference them: remove
or reassign dependent rows first. This intentionally preserves history rather
than using Django's SET NULL/cascade behavior. Deleting an Auth user cascades all
their app rows. The frontend must not expose service-role credentials.

Balance rows use ordered `FOR NO KEY UPDATE` locks (compatible with concurrent FK
KEY SHARE checks) and arithmetic updates. Repayment/outstanding constraints are
checked under these locks. Statement-level triggers additionally acquire a
transaction-scoped advisory lock keyed to the authenticated user **before** row
locks. This serializes same-user writes, including ordinary CRUD, against backup
restore and compound RPCs; different users remain independent. A queued write
commits after restore rather than being silently lost inside replacement. API
clients must reload IDs after restore. Private trigger functions are not
client-executable, have a pinned empty search path, and never rely on a
client-settable bypass flag.

## MFA assurance enforcement

`tracker_private.session_allowed()` is a STABLE security-definer predicate with
an empty search path. It requires `auth.uid()` **and an existing `auth.users`
row**, so a deleted user's still-signed AAL1/AAL2 JWT cannot access rows, invoke
RPCs, or upload receipt objects. It also checks the real Auth-owned
`auth.mfa_factors` table: when the user has **any verified factor**, the signed JWT
must contain `aal='aal2'`. Unverified first-enrollment factors do not lock out AAL1.
Another user's factors never affect the caller. The helper grants authenticated
users only its boolean result; no app grant exposes Auth factor rows.

Every app table's restrictive policy ANDs this requirement with all four owner
policies. Receipt SELECT/INSERT/UPDATE/DELETE policies have the same restrictive
gate for `tracker-receipts`. Thus a stale AAL1 access token cannot bypass MFA by
calling the Data/Storage API directly. All public RPCs also explicitly check the
gate, including every definer RPC; the original recurring implementation is now
private and cannot be called by a client. AAL1 reads/updates/deletes generally
see no rows; RPCs/inserts raise SQLSTATE `42501`. Clients should complete MFA and
use the refreshed AAL2 session before loading finances.

## RPC contracts

### `tracker_pay_card`

```js
const { data, error } = await supabase.rpc('tracker_pay_card', {
  p_card: cardId,
  p_amount: '75.00',
  p_account: accountId,
  p_date: '2026-10-25', // optional: database current_date
  p_notes: 'Monthly payment', // optional: ''
})
```

SQL signature: `(p_card bigint, p_amount numeric, p_account bigint,
p_date date DEFAULT current_date, p_notes text DEFAULT '')`.
Returns one `tracker_credit_card_activities` composite row. Invoker security;
requires the session/MFA gate and uses the same RLS/FKs/triggers as direct CRUD. It records
a PAYMENT activity with `payment_account=p_account`. Invalid ownership, nonpositive
amount, or amount above outstanding aborts the entire operation. Do not retry
after a network timeout without checking history; there is no idempotency key.

### `tracker_process_recurring`

```js
const { data, error } = await supabase.rpc('tracker_process_recurring')
// data = { created_count: 3, transaction_ids: [101, 102, 103] }
```

No arguments. Returns JSONB `{created_count: number, transaction_ids: bigint[]}`.
Security definer with pinned empty search path, explicit session/MFA guard,
and explicit ownership filters on every affected row. Processes only the
current user's due active rules, up to 100 occurrences **per rule per call**.
Locks rules with `FOR UPDATE SKIP LOCKED` to prevent duplicate concurrent runs.
All inserts/cursor changes/notifications in a call are atomic. Daily/weekly,
month-end clamping, and leap-year behavior follow Django's advancement rules.
End dates are inclusive. The database's `current_date` is used (normally UTC in
Supabase). This is on-demand processing, not a deployed background scheduler.
Call it on authenticated session data load, then refresh data and notifications.

### `tracker_summary()`

Read-only, STABLE, security invoker; returns one JSONB object:

```js
{
  dashboard: {
    total_income, total_expenses, total_bills, net_balance, account_balance,
    count, ocr_scanned_count, monthly_budget, borrowed_remaining,
    lent_remaining, unpaid_bills, savings_current
  },
  analytics: {
    month: { income, spend, budget, budget_percent, categories: [{ name, value }] },
    totals: { income, spend, average_spend, net, transaction_count },
    months: [{ key, label, income, spend, net }], // eight months, oldest first
    generated_at
  },
  insights: { generated_at, insights: [{ kind, title, message }] },
  forecast: {
    days_elapsed, days_left, days_in_month,
    categories: [{ category, spent, projected, budget, over_budget, daily_rate }]
  }
}
```

Dashboard and analytics keys match `DashboardSummaryView` and
`AnalyticsSummaryView`. SQL aggregates scan the complete owned ledger, independent
of PostgREST row limits. Total expense excludes BILL in the dashboard's separate
expense field; analytics spend includes EXPENSE+BILL. Monthly analytics/forecast
include the full calendar month, while insights use spending through today,
matching the original views. Forecast money fields are two-decimal **strings**,
`budget` may be null, and over-budget rows add `pace` and `message`. Other numeric
totals are JSON numbers. Date boundaries use the database timezone. Calculations
use PostgreSQL NUMERIC; half-way rounding follows PostgreSQL numeric rounding
rather than Python binary-float rounding. This is deterministic run-rate forecasting,
not a replacement for Django's trained merchant/ML classifier.

### `tracker_sync_notifications()`

No arguments; returns JSONB `{created: number, unread: number}`. Creates only the
caller's overdue/upcoming bill alerts (through five days ahead), monthly category
budget 80%/limit alerts, and upcoming active card payment alerts. Bill/budget
preferences are respected. Per-user dedupe keys make repeated and concurrent calls
idempotent. It does **not** run recurring rules; call `tracker_process_recurring`
explicitly first when loading session data. There is no offline scheduler.

### `tracker_import_expenses(p_rows jsonb)`

```js
await supabase.rpc('tracker_import_expenses', {
  p_rows: [{ account: accountId, amount: '12.50', title: 'Lunch',
    transaction_type: 'EXPENSE', category: 'Food', date: '2026-10-25' }]
})
// { created: 1, transaction_ids: [123] }
```

At most **1,000 rows and 2 MiB** per call; empty arrays return zero. `amount` is
required. The exact allowed fields are `account`, `title`, `amount`,
`transaction_type`, `category`, `payment_method`, `date`, `time`, `notes`,
`is_recurring`, `receipt_image`, `ocr_confidence`. Resolve CSV account names to
owned account IDs in the adapter before calling; this RPC does not create
accounts. Unknown fields, identity/owner/timestamp overrides, invalid amounts or
enums, and foreign accounts reject the entire batch. Defaults match expense CRUD.
All inserts and balance effects roll back together if any row fails. There is no
idempotency key: do not automatically repeat an uncertain successful upload.

### `tracker_export_backup()` and `tracker_restore_backup(p_data jsonb, p_confirm boolean)`

Export is a STABLE, RLS-scoped read returning:

```js
{
  format: 'smart-expense-supabase-v1',
  owner_id: 'supabase-user-uuid',
  exported_at: 'timestamp',
  tables: {
    tracker_profiles: [/* one settings object */],
    tracker_accounts: [/* snapshot rows with IDs and current balances */],
    // All 16 portable table keys are required, including empty arrays.
    // tracker_assistant_commands is excluded.
  }
}
```

Use the export object unchanged as `p_data`, with explicit `p_confirm: true`.
Restore returns `{restored: true, counts: {tracker_profiles: 1, ...}}`. Both export
and restore are bounded to **20,000 rows total and 10 MiB**. Only this new format
and the same authenticated owner are accepted; legacy Django/Railway formats and
cross-user restores are rejected. Each row must contain exactly its exported
columns. Extra/missing tables/columns, duplicate IDs, unresolved references, or
invalid values reject the entire operation.

Backup includes all 16 portable app-data tables, but excludes row `user_id`, server
`created_at`/`updated_at`, and profile Auth ID/legal acceptance timestamps. Restore
keeps the existing legal acceptances and assigns new server timestamps. IDs are
generated anew and every account/debt/card reference is remapped. Standard
notification dedupe keys are remapped too, preventing duplicate alerts after
restore. Recurring cursors and assistant settings/notes are included. Debt status
is recalculated for the current date, not trusted from the file.

Current account/card totals in the snapshot are converted back to opening balances
by subtracting exported ledger effects, then the history is replayed through the
normal finance triggers exactly once. Debt repayments are rebuilt from their rows
and checked against the exported amount-paid counter. Final account/card balances
are verified. No trigger is disabled and no client-accessible bypass flag exists.
The whole replacement is atomic and serialized with the user's other writes;
validation/replay failure leaves the original rows and IDs untouched.

**Scope and limits:** this is an app-data backup, not an Auth or Storage backup.
It contains receipt paths, not file bytes; existing same-user Storage objects stay
in place. Passwords, MFA factors, sessions, and legal acceptance records are never
imported. Near the extreme NUMERIC balance limit, reversal/replay can overflow an
intermediate balance even when the final value fits; the RPC then rejects and
rolls back completely rather than skipping records. Reload all collections after
success because prior IDs are stale. No partial-restore or legacy-import mode is
provided.

Assistant command history is deliberately excluded from the 16-table portable
backup (there are now 17 app tables total). Existing completed command/idempotency
records remain in the current account after restore; their replaced expense FKs
are set to null. Pending/clarification commands are atomically cancelled so a
preview against old data cannot later execute. Replaying an old completed request
UUID still returns its old result without recreating the restored transaction.

## In-app assistant

### Frontend adapter integration

`frontend/src/services/supabaseAssistant.js` exports:

```js
handleSupabaseAssistant(client, method, path, body = {})
```

It returns `{data,status}` for handled requests, returns `null` only for paths
outside `/api/v3/assistant/`, and throws Axios-shaped errors with
`error.response = {status,data:{error,detail,code,...}}`. Unknown assistant-prefixed
routes fail with 404 instead of falling through to Django. Inject the existing
Supabase client; the module has no client singleton, API base URL, or Railway
fallback. It verifies the current Auth user before accessing app data.

Supported routes preserve `Assistant.jsx`'s existing response shapes:

- GET/PATCH `settings/`: existing preference fields plus `wake_phrase`,
  `updated_at`, and a capabilities object. Validates names/enums/booleans.
- GET `history/`: `{results:[command,...]}`, newest 20.
- POST `message/`: `{message, client_request_id?, source?}`; TEXT or VOICE_APP.
  Returns the serialized command, status 201 for a new request or 200 for a retry.
- POST `commands/:id/confirm/` and `commands/:id/cancel/`: command response.
- GET/POST `notes/`, GET/PATCH/DELETE `notes/:id/`: owner-scoped note CRUD;
  listing returns `{results:[...]}`, max 50, matching the existing UI. Note content
  is limited to 2,000 characters; detail mutations reject identity/owner/audit fields.

The local parser lives in `frontend/src/services/assistantParser.js`. It handles
the existing English/Tamil/Tanglish expense/income, category, spending, balance,
budget, comparison and note patterns; digit amounts (including Tamil digits),
`k` suffixes, ISO dates, today/yesterday/this week/last month, and fresh pending
amount/category clarification. Examples tested include “Petrol ku 500 spend
panniten”, “இன்னைக்கு lunchக்கு 180 ரூபாய் செலவு பண்ணேன்”, “Salary 35k credit
aachu”, “இந்த மாதம் foodக்கு எவ்வளவு செலவு?”, and “500 illa 550”.

No external LLM/provider call exists. Parsing happens locally; only validated
structured payloads go to the authenticated Supabase RPC. Arbitrary SQL and bulk
mutation intents are not supported. This is a bounded deterministic parser, not
unrestricted natural-language understanding: spelled-out number words, arbitrary
merchant descriptions and arbitrary calendar phrases may require clarification.
Unknown requests fall back to a read-only financial summary. Responses remain
English as in the original service; the existing UI controls speech language.

### `tracker_assistant_prepare`

```js
await client.rpc('tracker_assistant_prepare', {
  p_request_id: clientRequestUuid,
  p_intent: 'CREATE_EXPENSE',
  p_payload: { amount: '500.00', category: 'Transport', title: 'Petrol',
    date: '2026-10-25', language: 'EN' },
  p_confidence: 0.9, // optional default 0
  p_source: 'TEXT', // optional; TEXT or VOICE_APP
  p_supersedes: null, // optional ID of a recent pending create clarification
})
// { command: { id, client_request_id, intent, status, confidence,
//   requires_confirmation, message, payload, result, created_at, executed_at },
//   created: true }
```

Signature: `(p_request_id uuid, p_intent text, p_payload jsonb,
p_confidence numeric DEFAULT 0, p_source text DEFAULT 'TEXT',
p_supersedes bigint DEFAULT NULL) RETURNS jsonb`.

Supported intents are CREATE_NOTE, CREATE_EXPENSE, CREATE_INCOME,
UPDATE_TRANSACTION, DELETE_TRANSACTION, GET_DAILY_SPENDING, GET_WEEKLY_SPENDING,
GET_MONTHLY_SPENDING, GET_CATEGORY_SPENDING, GET_SPENDING_SUMMARY, GET_BUDGET,
GET_BUDGET_STATUS, GET_BALANCE, GET_FINANCIAL_SUMMARY, COMPARE_SPENDING.

The incoming payload whitelist is `amount`, `corrected_amount`, `category`,
`title`, `transaction_type`, `date`, `period_start`, `period_end`, `period_label`,
`language`, `note_content`, `account`, `target_transaction_id`, `merchant`,
`filter_date`, `use_recent`. The server derives transaction type from the intent,
adds the source and safe target snapshot, validates bounded finite money/date/text
values, and rejects owner/status/snapshot injections. Missing account defaults to
the first owned account, matching the original assistant. If none exists, the
expense is unassigned (no account balance effect).

Preparation is idempotent on the owned request UUID, including simultaneous
submissions. Missing amount/category and ambiguous/missing update/delete targets
produce NEEDS_CLARIFICATION. Pending clarification replacement cancels the previous
owned create command only when it is still pending and under ten minutes old.
Single-row update/delete matches use explicit IDs or category/merchant/date filters;
ambiguous matches never select an arbitrary transaction.

Read intents aggregate complete owned ledger data in PostgreSQL and record their
result; they do not mutate financial rows. CREATE_NOTE saves immediately and
idempotently. Financial creates normally require confirmation. The existing
explicit `quick_add=true` + SMART preference permits validated high-confidence
(`>=0.92`) creates of at most 1,000 currency units, excluding recent duplicate
fingerprints. ALWAYS mode and update/delete actions retain confirmation.

### `tracker_assistant_confirm(p_command bigint)` / `tracker_assistant_cancel(p_command bigint)`

Both return the serialized command shape shown above. Every RPC checks live user
existence, MFA, and ownership, then takes the same per-user transactional write
lock as other financial mutations. Confirm also locks the command row, rechecks
account ownership/existence and amounts, and rejects a materially changed target
snapshot. Expense/income/update/delete effects run through the existing balance
triggers. Duplicate and concurrent confirmations return COMPLETED without applying
effects twice. Completed commands cannot be cancelled; cancelled/clarification
commands cannot be confirmed.

On an execution failure, the ledger subtransaction rolls back and the command is
persisted as FAILED with a safe message/error code. The RPC returns that FAILED
command; the frontend adapter converts it to HTTP-style 400 with `data.command`.
Submitting a new corrected request requires a new UUID. Missing/foreign commands
raise P0002 (adapter 404), invalid state raises 55000 (409), and failed session/MFA
checks raise 42501 (403).

### Explicit native background-wake gap

In-app browser/native speech-to-text can submit through the normal `message/`
route. Pass `source:'VOICE_APP'` when the caller identifies a voice transcript;
the existing UI's omitted source defaults to TEXT. Actual microphone/device
recognition was not exercised by unit or SQL tests.

Native background wake currently depends on Django's scoped `sew_` token and
HTTP bridge. No Supabase Edge bridge or new background token protocol is deployed.
All `wake-token/` and `wake/*` routes, enabling `background_wake_enabled`, and
VOICE_WAKE command sources fail explicitly with unsupported errors. Settings
responses advertise `background_wake_enabled:false`,
`capabilities.background_wake:false`, and `capabilities.external_llm:false`.
The adapter never returns a Railway token or URL. The legacy native service itself
is outside this module: an already-running legacy wake session must be stopped
through the native stop action; the main integration should keep legacy startup
disabled in Supabase mode. No full native/background parity is claimed.

## Signup and receipts

On Auth user insertion, metadata `name` and `phone` populate the profile. Metadata
`accepted_terms: true` and `accepted_privacy: true` record the current **server**
time, matching the registration adapter. Compatibility metadata
`terms_accepted_at` and `privacy_accepted_at` also accept ISO timestamps (or boolean
true); malformed timestamps become null. Missing declarations remain null rather
than causing all Auth/OAuth user creation to fail. The registration UI must require
the intended consent before submitting these flags.
These are user-supplied acceptance declarations, not proof of verified identity.
The trigger creates the original two defaults at zero: **Primary Bank / BANK**
and **Personal Cash Vault / CASH**, plus the assistant preferences row.
There is no trigger that imports or alters existing Django users.

Private bucket: **tracker-receipts**, max 10 MiB; JPEG, PNG, WebP, PDF.
Upload paths must be `${user.id}/${uniqueFilename}`. SELECT/INSERT/UPDATE/DELETE
policies require this first folder to equal `auth.uid()`. `receipt_image` stores
that path, not a public URL; use authenticated downloads or short-lived signed
URLs. The DB tests validate policies against storage interface stubs; actual file
uploads, MIME validation and signed URL delivery require a running Storage API.

## Local verification

From the repository root:

```sh
python -u supabase/tests/run_local.py
# If PostgreSQL is not on PATH:
python -u supabase/tests/run_local.py --pg-bin "C:/Program Files/PostgreSQL/18/bin"
```

Requires Python standard library and PostgreSQL tools `initdb`, `pg_ctl`, `psql`.
The runner creates a new temporary cluster on a random loopback port, applies
minimal Auth/Storage interfaces and every versioned migration, then runs real SQL
as `authenticated`/`anon` with independent JWT subjects and real concurrent client
connections. It ignores PG connection environment variables and DATABASE_URL;
there is no existing/remote database connection option. Cluster shutdown and
cleanup run in `finally`. Temporary trust authentication is local to this fresh
test cluster. `bootstrap.sql` is test-only and must never be a deployment migration.

Verified locally on PostgreSQL 18.3 / Windows: **427 security/finance/reporting/assistant SQL
assertions and 18 additional concurrency/cascade assertions passed** (445 total), with 68 independently
connected concurrent requests across the race scenarios. The suite covers per-table RLS read,
update, delete isolation and grants; spoofed owner IDs; foreign ownership on every
financial relation; protected counters/timestamps; invalid money/dates/types;
expense and transfer editing/reversal; debt/card overpayment atomic rollback;
recurring cursor/idempotence; receipt folder isolation; verified-factor AAL1/AAL2
policy and RPC enforcement; summaries beyond 1,000 rows; atomic CSV validation;
full backup roundtrip and invalid-restore rollback; and concurrent expenses,
transfers, debt/card repayment races, recurring/notification processing, and
restore versus queued CRUD. The prior assertion coverage remains in place.
Assistant tests additionally cover deleted-user JWT receipt denial, safe command
state transitions, stale-preview/account rejection, owner/MFA isolation, read
aggregates beyond 1,000 rows, quick-add preferences, restore invalidation, and
concurrent request/confirmation/note idempotency.

Frontend-only checks (no package script changes required):

```sh
cd frontend
node --test tests/supabase-assistant-parser.test.js tests/supabase-assistant.test.js
npm exec --no -- oxlint src/services/assistantParser.js src/services/supabaseAssistant.js tests/supabase-assistant-parser.test.js tests/supabase-assistant.test.js
```

**55 parser/adapter tests passed; targeted lint passed with no warnings.** Adapter
tests inject an SDK fixture; real authorization/finance behavior is covered by the
separate PostgreSQL suite, not claimed from a mocked backend.
Full Supabase Auth,
PostgREST and Storage HTTP integration is not exercised by this PostgreSQL-only
runner. Nothing has been deployed or applied to a cloud database.
