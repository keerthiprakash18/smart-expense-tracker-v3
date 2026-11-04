-- Bank statements remain local to the browser; only confirmed rows enter the ledger.
-- This additive migration does not modify existing transaction or account data.
begin;

create table public.tracker_bank_imports (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  account bigint not null,
  fingerprint varchar(64) not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  expense bigint not null references public.tracker_expenses(id) on delete cascade,
  imported_at timestamptz not null default now(),
  foreign key (user_id, account) references public.tracker_accounts(user_id, id),
  unique (user_id, account, fingerprint)
);
create index tracker_bank_imports_user_date on public.tracker_bank_imports(user_id, imported_at desc);
alter table public.tracker_bank_imports enable row level security;
revoke all on public.tracker_bank_imports from public, anon, authenticated;
revoke all on sequence public.tracker_bank_imports_id_seq from public, anon, authenticated;
grant select on public.tracker_bank_imports to authenticated;
create policy owner_select on public.tracker_bank_imports for select to authenticated
  using (user_id = (select auth.uid()));
create policy session_assurance on public.tracker_bank_imports as restrictive for all to authenticated
  using ((select tracker_private.session_allowed()))
  with check ((select tracker_private.session_allowed()));
create trigger serialize_user_writes
  before insert or update or delete on public.tracker_bank_imports
  for each statement execute function tracker_private.lock_user_writes();

create function public.tracker_import_bank_statement(p_account bigint, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid();
  r jsonb;
  expense_id bigint;
  n_created int := 0;
  n_duplicate int := 0;
  tx_date date;
  tx_amount public.tracker_money;
  tx_title text;
  tx_type text;
  tx_fingerprint text;
  tx_category text;
  tx_method text;
begin
  if not tracker_private.session_allowed() then
    raise exception 'Authentication or MFA verification required' using errcode='42501';
  end if;
  if p_account is null or not exists (
    select 1 from public.tracker_accounts where id=p_account and user_id=u
  ) then
    raise exception 'Choose an account you own' using errcode='42501';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array'
     or jsonb_array_length(p_rows) = 0
     or jsonb_array_length(p_rows) > 1000
     or octet_length(p_rows::text) > 2097152 then
    raise exception 'Import requires 1-1000 entries and no more than 2 MiB' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));
  for r in select value from jsonb_array_elements(p_rows) loop
    perform tracker_private.validate_keys(
      r,
      array['fingerprint','title','amount','transaction_type','category','payment_method','date','confirmed_existing'],
      array['fingerprint','title','amount','transaction_type','date']
    );
    tx_fingerprint := r->>'fingerprint';
    tx_title := btrim(r->>'title');
    tx_type := r->>'transaction_type';
    tx_category := coalesce(nullif(btrim(r->>'category'),''),'Uncategorized');
    tx_method := coalesce(nullif(btrim(r->>'payment_method'),''),'BANK_TRANSFER');
    if tx_fingerprint !~ '^[0-9a-f]{64}$'
      or tx_title is null or tx_title = '' or length(tx_title) > 200
      or tx_type not in ('EXPENSE','INCOME')
      or length(tx_category)>100 or length(tx_method)>50
      or jsonb_typeof(r->'amount') not in ('string','number') then
      raise exception 'Invalid bank import row' using errcode='22023';
    end if;
    tx_date := (r->>'date')::date;
    tx_amount := (r->>'amount')::numeric;
    if tx_amount <= 0 or not isfinite(tx_date) then
      raise exception 'Invalid bank statement date or amount' using errcode='22023';
    end if;
    if tx_type = 'EXPENSE' and tx_title ~* '(self[ -]?transfer|own a/c|own account|credit card payment|credit card bill|cc payment|card settlement)' then
      raise exception 'Transfers and credit card payments need manual reconciliation' using errcode='22023';
    end if;
    if exists (
      select 1 from public.tracker_bank_imports
      where user_id=u and account=p_account and fingerprint=tx_fingerprint
    ) then
      n_duplicate := n_duplicate + 1;
      continue;
    end if;
    if exists (
      select 1 from public.tracker_expenses
      where user_id=u and account=p_account and date=tx_date
        and amount=tx_amount and transaction_type=tx_type
    ) and coalesce(r->>'confirmed_existing','false') <> 'true' then
      raise exception 'Possible matching transaction requires explicit confirmation' using errcode='22023';
    end if;
    insert into public.tracker_expenses(
      user_id, account, title, amount, transaction_type, category,
      payment_method, date, notes
    ) values (
      u, p_account, tx_title, tx_amount, tx_type,
      tx_category, tx_method, tx_date, 'Imported from reviewed bank statement'
    ) returning id into expense_id;
    insert into public.tracker_bank_imports(user_id, account, fingerprint, expense)
      values (u,p_account,tx_fingerprint,expense_id);
    n_created := n_created + 1;
  end loop;
  return jsonb_build_object('created',n_created,'already_imported',n_duplicate);
end $$;
revoke all on function public.tracker_import_bank_statement(bigint,jsonb) from public,anon;
grant execute on function public.tracker_import_bank_statement(bigint,jsonb) to authenticated;
commit;
