begin;

create function tracker_private.validate_keys(value jsonb,allowed text[],required text[] default '{}') returns void
language plpgsql set search_path = '' as $$
declare k text;
begin
  if jsonb_typeof(value) is distinct from 'object' then raise exception 'Each row must be an object' using errcode='22023'; end if;
  for k in select jsonb_object_keys(value) loop
    if not k=any(allowed) then raise exception 'Unsupported field: %',k using errcode='22023'; end if;
  end loop;
  foreach k in array required loop
    if not value ? k then raise exception 'Missing field: %',k using errcode='22023'; end if;
  end loop;
end $$;

create function public.tracker_import_expenses(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r jsonb; new_id bigint; ids bigint[] := '{}';
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'p_rows must be an array' using errcode='22023'; end if;
  if jsonb_array_length(p_rows)>1000 or octet_length(p_rows::text)>2097152 then raise exception 'Import limit: 1000 rows and 2 MiB' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));
  for r in select value from jsonb_array_elements(p_rows) loop
    perform tracker_private.validate_keys(r,array['account','title','amount','transaction_type','category','payment_method','date','time','notes','is_recurring','receipt_image','ocr_confidence'],array['amount']);
    insert into public.tracker_expenses(user_id,account,title,amount,transaction_type,category,payment_method,date,time,notes,is_recurring,receipt_image,ocr_confidence)
      values(u,(r->>'account')::bigint,coalesce(r->>'title','Transaction'),(r->>'amount')::numeric,
        coalesce(r->>'transaction_type','EXPENSE'),coalesce(r->>'category','General'),coalesce(r->>'payment_method','UPI'),
        coalesce((r->>'date')::date,current_date),coalesce(r->>'time','12:00'),r->>'notes',coalesce((r->>'is_recurring')::boolean,false),
        r->>'receipt_image',(r->>'ocr_confidence')::numeric) returning id into new_id;
    ids := array_append(ids,new_id);
  end loop;
  return jsonb_build_object('created',cardinality(ids),'transaction_ids',to_jsonb(ids));
end $$;

-- Fixed allowlist, never a caller-controlled table/schema identifier.
create function tracker_private.backup_tables() returns text[] language sql immutable set search_path='' as $$
  select array['tracker_profiles','tracker_accounts','tracker_credit_cards','tracker_money_debts',
    'tracker_categories','tracker_bills','tracker_savings_goals','tracker_category_budgets',
    'tracker_recurring_rules','tracker_expenses','tracker_transfers','tracker_debt_payments',
    'tracker_credit_card_activities','tracker_notifications','tracker_assistant_profiles','tracker_assistant_notes']
$$;

create function tracker_private.backup_columns(t text) returns text[] language plpgsql stable set search_path='' as $$
declare cols text[];
begin
  if not t=any(tracker_private.backup_tables()) then raise exception 'Unsupported table' using errcode='22023'; end if;
  select array_agg(a.attname::text order by a.attnum) into cols from pg_attribute a
    where a.attrelid=('public.'||t)::regclass and a.attnum>0 and not a.attisdropped
      and a.attname not in ('user_id','created_at','updated_at')
      and (t<>'tracker_profiles' or a.attname not in ('id','terms_accepted_at','privacy_accepted_at'));
  return cols;
end $$;

create function public.tracker_export_backup() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare u uuid := auth.uid(); t text; rows jsonb; tables jsonb := '{}'; result jsonb; total integer := 0;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  foreach t in array array['tracker_profiles','tracker_accounts','tracker_credit_cards','tracker_money_debts',
    'tracker_categories','tracker_bills','tracker_savings_goals','tracker_category_budgets','tracker_recurring_rules',
    'tracker_expenses','tracker_transfers','tracker_debt_payments','tracker_credit_card_activities',
    'tracker_notifications','tracker_assistant_profiles','tracker_assistant_notes'] loop
    if t='tracker_profiles' then
      select coalesce(jsonb_agg(to_jsonb(p)-'id'-'terms_accepted_at'-'privacy_accepted_at'),'[]') into rows from public.tracker_profiles p where id=u;
      if jsonb_array_length(rows)<>1 then raise exception 'Profile must exist before backup' using errcode='22023'; end if;
    else
      execute format('select coalesce(jsonb_agg(to_jsonb(r)-''user_id''-''created_at''-''updated_at'' order by id),''[]'') from public.%I r where user_id=$1',t) into rows using u;
    end if;
    total := total+jsonb_array_length(rows);
    tables := tables || jsonb_build_object(t,rows);
  end loop;
  result := jsonb_build_object('format','smart-expense-supabase-v1','owner_id',u,'exported_at',statement_timestamp(),'tables',tables);
  if total>20000 or octet_length(result::text)>10485760 then raise exception 'Backup limit: 20000 rows total and 10 MiB' using errcode='22023'; end if;
  return result;
end $$;

create function tracker_private.map_backup_id(maps jsonb,t text,value jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare result jsonb;
begin
  if value is null or value='null'::jsonb then return 'null'::jsonb; end if;
  if jsonb_typeof(value)<>'number' then raise exception 'Reference must be a numeric backup ID' using errcode='22023'; end if;
  result := maps->t->(value #>> '{}');
  if result is null then raise exception 'Unknown backup reference in %: %',t,value using errcode='22023'; end if;
  return result;
end $$;

create function tracker_private.insert_backup_row(t text,r jsonb) returns bigint
language plpgsql set search_path='' as $$
declare cols text; new_id bigint;
begin
  if not t=any(tracker_private.backup_tables()) or t='tracker_profiles' then raise exception 'Unsupported table' using errcode='22023'; end if;
  select string_agg(quote_ident(k),',' order by k) into cols from jsonb_object_keys(r) k
    where k not in ('id','user_id','created_at','updated_at','amount_paid','status');
  execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) returning id',t,cols,cols,t)
    into new_id using r;
  return new_id;
end $$;

create function public.tracker_restore_backup(p_data jsonb,p_confirm boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare
  u uuid := auth.uid(); tables jsonb; t text; r jsonb; old_id text; new_id bigint;
  cols text[]; maps jsonb := '{}'; counts jsonb := '{}'; total integer := 0;
  account_net jsonb; card_net jsonb; opening numeric; saved_profile public.tracker_profiles;
  dedupe text; dedupe_parts text[]; parent_table text; mapped_parent text;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  if p_confirm is distinct from true then raise exception 'Explicit restore confirmation required' using errcode='22023'; end if;
  perform tracker_private.validate_keys(p_data,array['format','owner_id','exported_at','tables'],array['format','owner_id','exported_at','tables']);
  if p_data->>'format' is distinct from 'smart-expense-supabase-v1' then raise exception 'Only smart-expense-supabase-v1 backups are supported; legacy imports are not accepted' using errcode='22023'; end if;
  if p_data->>'owner_id' is distinct from u::text then raise exception 'Backup belongs to a different user' using errcode='42501'; end if;
  if octet_length(p_data::text)>10485760 then raise exception 'Backup exceeds 10 MiB' using errcode='22023'; end if;
  tables := p_data->'tables';
  perform tracker_private.validate_keys(tables,tracker_private.backup_tables(),tracker_private.backup_tables());
  foreach t in array tracker_private.backup_tables() loop
    if jsonb_typeof(tables->t) is distinct from 'array' then raise exception 'Table % must be an array',t using errcode='22023'; end if;
    total := total+jsonb_array_length(tables->t);
    if total>20000 then raise exception 'Backup exceeds 20000 rows' using errcode='22023'; end if;
    counts := counts || jsonb_build_object(t,jsonb_array_length(tables->t));
    cols := tracker_private.backup_columns(t);
    maps := maps || jsonb_build_object(t,'{}'::jsonb);
    for r in select value from jsonb_array_elements(tables->t) loop
      perform tracker_private.validate_keys(r,cols,cols);
      if t<>'tracker_profiles' then
        if jsonb_typeof(r->'id') is distinct from 'number' or (r->>'id')::bigint<=0 then raise exception 'Invalid backup ID' using errcode='22023'; end if;
        old_id := r->>'id';
        if maps->t ? old_id then raise exception 'Duplicate backup ID in %',t using errcode='22023'; end if;
        maps := jsonb_set(maps,array[t,old_id],'null'::jsonb);
      end if;
    end loop;
  end loop;
  if jsonb_array_length(tables->'tracker_profiles')<>1 or jsonb_array_length(tables->'tracker_assistant_profiles')>1 then
    raise exception 'Backup must have one profile and at most one assistant profile' using errcode='22023';
  end if;

  -- Backups store current balances. Recover opening balances before replaying
  -- history through the normal triggers so ledger effects are counted once.
  select coalesce(jsonb_object_agg(account,delta),'{}') into account_net from (
    select account,sum(delta) delta from (
      select x->>'account' account,(x->>'amount')::numeric * case when x->>'transaction_type'='INCOME' then 1 else -1 end delta
        from jsonb_array_elements(tables->'tracker_expenses') x where x->>'account' is not null
      union all select x->>'from_account',-(x->>'amount')::numeric from jsonb_array_elements(tables->'tracker_transfers') x
      union all select x->>'to_account',(x->>'amount')::numeric from jsonb_array_elements(tables->'tracker_transfers') x
      union all select x->>'payment_account',-(x->>'amount')::numeric from jsonb_array_elements(tables->'tracker_credit_card_activities') x where x->>'activity_type'='PAYMENT'
    ) legs where account is not null group by account
  ) q;
  select coalesce(jsonb_object_agg(card,delta),'{}') into card_net from (
    select x->>'card' card,sum((x->>'amount')::numeric * case x->>'activity_type' when 'PAYMENT' then -1 when 'ADJUSTMENT' then (x->>'adjustment_direction')::integer else 1 end) delta
    from jsonb_array_elements(tables->'tracker_credit_card_activities') x group by x->>'card'
  ) q;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));

  -- Reverse negative card activities first to avoid a temporary negative debt.
  delete from public.tracker_credit_card_activities where user_id=u and (activity_type='PAYMENT' or (activity_type='ADJUSTMENT' and adjustment_direction=-1));
  delete from public.tracker_credit_card_activities where user_id=u;
  delete from public.tracker_debt_payments where user_id=u;
  delete from public.tracker_transfers where user_id=u;
  delete from public.tracker_expenses where user_id=u;
  delete from public.tracker_recurring_rules where user_id=u;
  delete from public.tracker_credit_cards where user_id=u;
  delete from public.tracker_accounts where user_id=u;
  delete from public.tracker_money_debts where user_id=u;
  delete from public.tracker_categories where user_id=u;
  delete from public.tracker_bills where user_id=u;
  delete from public.tracker_savings_goals where user_id=u;
  delete from public.tracker_category_budgets where user_id=u;
  delete from public.tracker_notifications where user_id=u;
  delete from public.tracker_assistant_profiles where user_id=u;
  delete from public.tracker_assistant_notes where user_id=u;

  saved_profile := jsonb_populate_record(null::public.tracker_profiles,tables->'tracker_profiles'->0);
  insert into public.tracker_profiles(id,name,phone,country,currency,monthly_budget,savings_goal,dark_mode,budget_alerts,bill_reminders)
    values(u,saved_profile.name,saved_profile.phone,saved_profile.country,saved_profile.currency,saved_profile.monthly_budget,
      saved_profile.savings_goal,saved_profile.dark_mode,saved_profile.budget_alerts,saved_profile.bill_reminders)
    on conflict(id) do update set name=excluded.name,phone=excluded.phone,country=excluded.country,currency=excluded.currency,
      monthly_budget=excluded.monthly_budget,savings_goal=excluded.savings_goal,dark_mode=excluded.dark_mode,
      budget_alerts=excluded.budget_alerts,bill_reminders=excluded.bill_reminders;

  foreach t in array tracker_private.backup_tables() loop
    if t='tracker_profiles' then continue; end if;
    -- Purchases/increasing adjustments first, then payments/reductions. Current
    -- ledger IDs need not reflect semantic order after historical edits.
    for r in select value from jsonb_array_elements(tables->t)
      order by case when t='tracker_credit_card_activities' and (value->>'activity_type'='PAYMENT' or (value->>'activity_type'='ADJUSTMENT' and value->>'adjustment_direction'='-1')) then 1 else 0 end,
        (value->>'id')::bigint loop
      old_id := r->>'id';
      if t='tracker_accounts' then
        opening := (r->>'balance')::numeric-coalesce((account_net->>old_id)::numeric,0);
        r := jsonb_set(r,'{balance}',to_jsonb(opening));
      elsif t='tracker_credit_cards' then
        opening := (r->>'outstanding')::numeric-coalesce((card_net->>old_id)::numeric,0);
        r := jsonb_set(r,'{outstanding}',to_jsonb(opening));
        r := jsonb_set(r,'{linked_account}',tracker_private.map_backup_id(maps,'tracker_accounts',r->'linked_account'));
      elsif t in ('tracker_expenses','tracker_recurring_rules') then
        r := jsonb_set(r,'{account}',tracker_private.map_backup_id(maps,'tracker_accounts',r->'account'));
      elsif t='tracker_transfers' then
        r := jsonb_set(r,'{from_account}',tracker_private.map_backup_id(maps,'tracker_accounts',r->'from_account'));
        r := jsonb_set(r,'{to_account}',tracker_private.map_backup_id(maps,'tracker_accounts',r->'to_account'));
      elsif t='tracker_debt_payments' then
        r := jsonb_set(r,'{debt}',tracker_private.map_backup_id(maps,'tracker_money_debts',r->'debt'));
      elsif t='tracker_credit_card_activities' then
        r := jsonb_set(r,'{card}',tracker_private.map_backup_id(maps,'tracker_credit_cards',r->'card'));
        r := jsonb_set(r,'{payment_account}',tracker_private.map_backup_id(maps,'tracker_accounts',r->'payment_account'));
      elsif t='tracker_notifications' then
        dedupe := r->>'dedupe_key';
        dedupe_parts := regexp_match(dedupe,'^(bill|budget|card|recurring):([0-9]+):(.*)$');
        if dedupe_parts is not null then
          parent_table := case dedupe_parts[1] when 'bill' then 'tracker_bills' when 'budget' then 'tracker_category_budgets'
            when 'card' then 'tracker_credit_cards' else 'tracker_recurring_rules' end;
          mapped_parent := maps->parent_table->>dedupe_parts[2];
          if mapped_parent is not null then
            r := jsonb_set(r,'{dedupe_key}',to_jsonb(dedupe_parts[1] || ':' || mapped_parent || ':' || dedupe_parts[3]));
          end if;
        end if;
      end if;
      new_id := tracker_private.insert_backup_row(t,r);
      maps := jsonb_set(maps,array[t,old_id],to_jsonb(new_id));
    end loop;
  end loop;

  -- Check final counters against the snapshot, including debt counters that were
  -- rebuilt rather than trusted. Any mismatch aborts the entire restore.
  for r in select value from jsonb_array_elements(tables->'tracker_accounts') loop
    if (select balance from public.tracker_accounts where user_id=u and id=(maps->'tracker_accounts'->>(r->>'id'))::bigint) is distinct from (r->>'balance')::numeric then
      raise exception 'Account balance mismatch' using errcode='22023'; end if;
  end loop;
  for r in select value from jsonb_array_elements(tables->'tracker_credit_cards') loop
    if (select outstanding from public.tracker_credit_cards where user_id=u and id=(maps->'tracker_credit_cards'->>(r->>'id'))::bigint) is distinct from (r->>'outstanding')::numeric then
      raise exception 'Card outstanding mismatch' using errcode='22023'; end if;
  end loop;
  for r in select value from jsonb_array_elements(tables->'tracker_money_debts') loop
    if (select amount_paid from public.tracker_money_debts where user_id=u and id=(maps->'tracker_money_debts'->>(r->>'id'))::bigint) is distinct from (r->>'amount_paid')::numeric then
      raise exception 'Debt payment total mismatch' using errcode='22023'; end if;
  end loop;
  return jsonb_build_object('restored',true,'counts',counts);
end $$;

revoke all on function tracker_private.validate_keys(jsonb,text[],text[]),tracker_private.backup_tables(),
  tracker_private.backup_columns(text),tracker_private.map_backup_id(jsonb,text,jsonb),tracker_private.insert_backup_row(text,jsonb)
  from public,anon,authenticated;
revoke all on function public.tracker_import_expenses(jsonb),public.tracker_export_backup(),public.tracker_restore_backup(jsonb,boolean) from public,anon;
grant execute on function public.tracker_import_expenses(jsonb),public.tracker_export_backup(),public.tracker_restore_backup(jsonb,boolean) to authenticated;
commit;
