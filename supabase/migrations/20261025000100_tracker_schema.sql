-- Fresh Supabase backend. No Django data or authentication secrets are imported.
begin;

create schema if not exists tracker_private;
revoke all on schema tracker_private from public, anon, authenticated;

create domain public.tracker_money as numeric(12,2)
  check (value > '-Infinity'::numeric and value < 'Infinity'::numeric);

create table public.tracker_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name varchar(150) not null default '', phone varchar(20),
  country varchar(50) not null default 'India', currency varchar(10) not null default '₹',
  monthly_budget public.tracker_money not null default 45000 check (monthly_budget >= 0),
  savings_goal public.tracker_money not null default 100000 check (savings_goal >= 0),
  dark_mode boolean not null default true, budget_alerts boolean not null default true,
  bill_reminders boolean not null default true,
  terms_accepted_at timestamptz, privacy_accepted_at timestamptz
);

create table public.tracker_accounts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name varchar(100) not null default 'Primary Account' check (length(trim(name)) > 0),
  account_type varchar(20) not null default 'BANK' check (account_type in ('BANK','UPI','CASH','CARD','WALLET','CUSTOM')),
  balance public.tracker_money not null default 0,
  created_at timestamptz not null default now(), unique (user_id,id)
);
create unique index tracker_accounts_name on public.tracker_accounts(user_id,lower(trim(name)));

create table public.tracker_expenses (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account bigint, title varchar(200) not null default 'Transaction' check (length(trim(title)) > 0),
  amount public.tracker_money not null check (amount > 0),
  transaction_type varchar(10) not null default 'EXPENSE' check (transaction_type in ('EXPENSE','INCOME','BILL')),
  category varchar(100) not null default 'General', payment_method varchar(50) not null default 'UPI',
  date date not null default current_date check (isfinite(date)),
  time varchar(10) not null default '12:00' check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'),
  notes text, is_recurring boolean not null default false, receipt_image text,
  ocr_confidence numeric(5,2) check (ocr_confidence between 0 and 100),
  created_at timestamptz not null default now(),
  foreign key (user_id,account) references public.tracker_accounts(user_id,id),
  check (receipt_image is null or split_part(receipt_image,'/',1) = user_id::text)
);

create table public.tracker_bills (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title varchar(150) not null check (length(trim(title)) > 0),
  amount public.tracker_money not null check (amount > 0), due_date date not null check (isfinite(due_date)),
  category varchar(100) not null default 'Bills & Utilities', is_paid boolean not null default false,
  is_recurring boolean not null default true, created_at timestamptz not null default now()
);
create table public.tracker_savings_goals (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name varchar(150) not null check (length(trim(name)) > 0),
  target_amount public.tracker_money not null check (target_amount > 0),
  current_amount public.tracker_money not null default 0 check (current_amount >= 0 and current_amount <= target_amount),
  target_date date check (isfinite(target_date)), icon varchar(50) not null default '🎯',
  created_at timestamptz not null default now()
);
create table public.tracker_money_debts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  direction varchar(10) not null check (direction in ('BORROWED','LENT')),
  person_name varchar(150) not null check (length(trim(person_name)) > 0),
  amount public.tracker_money not null check (amount > 0),
  amount_paid public.tracker_money not null default 0 check (amount_paid >= 0 and amount_paid <= amount),
  transaction_date date not null default current_date check (isfinite(transaction_date)),
  due_date date check (isfinite(due_date)), purpose varchar(200) not null default '', notes text,
  status varchar(10) not null default 'PENDING' check (status in ('PENDING','PARTIAL','PAID','OVERDUE')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), unique(user_id,id)
);
create table public.tracker_debt_payments (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  debt bigint not null, amount public.tracker_money not null check (amount > 0),
  payment_date date not null default current_date check (isfinite(payment_date)), notes text,
  created_at timestamptz not null default now(),
  foreign key(user_id,debt) references public.tracker_money_debts(user_id,id)
);
create table public.tracker_transfers (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  from_account bigint not null, to_account bigint not null,
  amount public.tracker_money not null check (amount > 0),
  date date not null default current_date check (isfinite(date)), notes text not null default '',
  created_at timestamptz not null default now(), check (from_account <> to_account),
  foreign key(user_id,from_account) references public.tracker_accounts(user_id,id),
  foreign key(user_id,to_account) references public.tracker_accounts(user_id,id)
);
create table public.tracker_category_budgets (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  category varchar(100) not null check (length(trim(category)) > 0),
  amount public.tracker_money not null check (amount > 0),
  period varchar(20) not null default 'MONTHLY' check (period = 'MONTHLY'), active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,category,period)
);
create table public.tracker_recurring_rules (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title varchar(200) not null check (length(trim(title)) > 0),
  amount public.tracker_money not null check (amount > 0),
  transaction_type varchar(10) not null default 'EXPENSE' check (transaction_type in ('EXPENSE','INCOME','BILL')),
  category varchar(100) not null default 'General', account bigint,
  payment_method varchar(50) not null default 'UPI',
  frequency varchar(20) not null default 'MONTHLY' check (frequency in ('DAILY','WEEKLY','MONTHLY','YEARLY')),
  interval integer not null default 1 check (interval between 1 and 365),
  next_run date not null default current_date check (isfinite(next_run)),
  end_date date check (isfinite(end_date)), active boolean not null default true,
  last_run date check (isfinite(last_run)), notes text not null default '',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (not active or end_date is null or end_date >= next_run),
  foreign key(user_id,account) references public.tracker_accounts(user_id,id)
);
create table public.tracker_categories (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name varchar(100) not null check (length(trim(name)) > 0),
  category_type varchar(10) not null default 'EXPENSE' check (category_type in ('EXPENSE','INCOME')),
  color varchar(20) not null default '#0A84FF', icon varchar(50) not null default 'Tag'
);
create unique index tracker_categories_name on public.tracker_categories(user_id,lower(trim(name)));
create table public.tracker_credit_cards (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name varchar(120) not null check (length(trim(name)) > 0),
  last4 varchar(4) not null default '' check (last4 = '' or last4 ~ '^[0-9]{4}$'),
  credit_limit public.tracker_money not null default 0 check (credit_limit >= 0),
  outstanding public.tracker_money not null default 0 check (outstanding >= 0),
  statement_day smallint not null default 1 check (statement_day between 1 and 28),
  due_day smallint not null default 20 check (due_day between 1 and 28), linked_account bigint,
  active boolean not null default true, created_at timestamptz not null default now(), unique(user_id,id),
  foreign key(user_id,linked_account) references public.tracker_accounts(user_id,id)
);
create table public.tracker_credit_card_activities (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  card bigint not null,
  activity_type varchar(20) not null check (activity_type in ('PURCHASE','PAYMENT','ADJUSTMENT')),
  amount public.tracker_money not null check (amount > 0),
  date date not null default current_date check (isfinite(date)), notes varchar(240) not null default '',
  payment_account bigint, adjustment_direction smallint not null default 1 check (adjustment_direction in (-1,1)),
  created_at timestamptz not null default now(),
  check ((activity_type = 'PAYMENT' and payment_account is not null) or (activity_type <> 'PAYMENT' and payment_account is null)),
  check (activity_type = 'ADJUSTMENT' or adjustment_direction = 1),
  foreign key(user_id,card) references public.tracker_credit_cards(user_id,id),
  foreign key(user_id,payment_account) references public.tracker_accounts(user_id,id)
);
create table public.tracker_notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind varchar(20) not null default 'SYSTEM' check (kind in ('BILL','BUDGET','RECURRING','CARD','SECURITY','SYSTEM')),
  title varchar(160) not null, message text not null, due_date date check (isfinite(due_date)),
  action_url varchar(240) not null default '', is_read boolean not null default false,
  dedupe_key varchar(200), created_at timestamptz not null default now(), unique(user_id,dedupe_key)
);
create table public.tracker_assistant_profiles (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() unique references auth.users(id) on delete cascade,
  assistant_name varchar(40) not null default 'Nova',
  language varchar(10) not null default 'AUTO' check (language in ('AUTO','EN','TA')),
  voice_responses boolean not null default true,
  personality varchar(20) not null default 'FRIENDLY' check (personality in ('FRIENDLY','PROFESSIONAL','MINIMAL')),
  confirmation_mode varchar(20) not null default 'SMART' check (confirmation_mode in ('SMART','ALWAYS')),
  quick_add boolean not null default false, background_wake_enabled boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.tracker_assistant_notes (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  content text not null check (length(trim(content)) > 0),
  source varchar(20) not null default 'TEXT' check (source in ('VOICE_WAKE','VOICE_APP','TEXT')),
  is_done boolean not null default false, reminder_at timestamptz check (isfinite(reminder_at)),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

-- Explicit per-operation RLS, and column grants: clients cannot change ownership,
-- identity, server timestamps, or aggregate balances. Opening balances are allowed.
do $$
declare t record; insert_cols text; update_cols text;
begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' loop
    execute format('alter table public.%I enable row level security',t.tablename);
    execute format('revoke all on public.%I from public, anon, authenticated',t.tablename);
    if t.tablename = 'tracker_profiles' then
      execute format('create policy owner_select on public.%I for select to authenticated using (id = (select auth.uid()))',t.tablename);
      execute format('create policy owner_insert on public.%I for insert to authenticated with check (id = (select auth.uid()))',t.tablename);
      execute format('create policy owner_update on public.%I for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()))',t.tablename);
      execute format('create policy owner_delete on public.%I for delete to authenticated using (id = (select auth.uid()))',t.tablename);
    else
      execute format('create policy owner_select on public.%I for select to authenticated using (user_id = (select auth.uid()))',t.tablename);
      execute format('create policy owner_insert on public.%I for insert to authenticated with check (user_id = (select auth.uid()))',t.tablename);
      execute format('create policy owner_update on public.%I for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))',t.tablename);
      execute format('create policy owner_delete on public.%I for delete to authenticated using (user_id = (select auth.uid()))',t.tablename);
      execute format('create index %I on public.%I(user_id)',t.tablename || '_owner',t.tablename);
      -- Supabase projects may install permissive default sequence privileges.
      -- Identity allocation needs no direct sequence grant for inserts.
      execute format('revoke all on sequence %s from public, anon, authenticated',pg_get_serial_sequence('public.' || t.tablename,'id'));
    end if;
    select string_agg(quote_ident(column_name),',') into insert_cols from information_schema.columns
      where table_schema='public' and table_name=t.tablename
      and column_name not in ('id','created_at','updated_at','amount_paid','status','last_run');
    select string_agg(quote_ident(column_name),',') into update_cols from information_schema.columns
      where table_schema='public' and table_name=t.tablename
      and column_name not in ('id','user_id','created_at','updated_at','balance','outstanding','amount_paid','status','last_run','terms_accepted_at','privacy_accepted_at');
    execute format('grant select,delete on public.%I to authenticated',t.tablename);
    if t.tablename <> 'tracker_profiles' then
      execute format('grant insert (%s) on public.%I to authenticated',insert_cols,t.tablename);
    end if;
    execute format('grant update (%s) on public.%I to authenticated',update_cols,t.tablename);
  end loop;
end $$;

create index tracker_expenses_date on public.tracker_expenses(user_id,date desc,id desc);
create index tracker_expenses_category on public.tracker_expenses(user_id,category,date);
create index tracker_expenses_account on public.tracker_expenses(user_id,account);
create index tracker_transfers_from on public.tracker_transfers(user_id,from_account);
create index tracker_transfers_to on public.tracker_transfers(user_id,to_account);
create index tracker_debt_payments_debt on public.tracker_debt_payments(user_id,debt,payment_date desc);
create index tracker_cards_account on public.tracker_credit_cards(user_id,linked_account);
create index tracker_activities_card on public.tracker_credit_card_activities(user_id,card,date desc);
create index tracker_activities_account on public.tracker_credit_card_activities(user_id,payment_account);
create index tracker_recurring_due on public.tracker_recurring_rules(user_id,next_run) where active;
create index tracker_recurring_account on public.tracker_recurring_rules(user_id,account);
create index tracker_bills_due on public.tracker_bills(user_id,due_date) where not is_paid;
create index tracker_notifications_unread on public.tracker_notifications(user_id,created_at desc) where not is_read;
create index tracker_notes_done on public.tracker_assistant_notes(user_id,is_done,created_at desc);
commit;
