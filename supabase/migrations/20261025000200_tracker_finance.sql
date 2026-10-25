begin;

create function tracker_private.protect_row() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or to_jsonb(new)->'user_id' is distinct from to_jsonb(old)->'user_id' then
      raise exception 'Identity and owner are immutable' using errcode='42501';
    end if;
    if to_jsonb(new)->'created_at' is distinct from to_jsonb(old)->'created_at' then
      raise exception 'Creation timestamp is immutable' using errcode='42501';
    end if;
  end if;
  if to_jsonb(new) ? 'updated_at' then new := jsonb_populate_record(new,jsonb_build_object('updated_at',statement_timestamp())); end if;
  return new;
end $$;
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' loop
    execute format('create trigger protect_row before insert or update on public.%I for each row execute function tracker_private.protect_row()',t.tablename);
  end loop;
end $$;

create function tracker_private.expense_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.tracker_expenses; n public.tracker_expenses; u uuid;
begin
  if tg_op <> 'INSERT' then o := old; end if;
  if tg_op <> 'DELETE' then n := new; end if;
  u := coalesce(n.user_id,o.user_id);
  -- NO KEY UPDATE serializes balances without conflicting with concurrent FK
  -- KEY SHARE locks; stable order also protects opposing account moves.
  perform id from public.tracker_accounts where user_id=u and id in (o.account,n.account) order by id for no key update;
  update public.tracker_accounts a set balance=a.balance
    - case when a.id=o.account then case when o.transaction_type='INCOME' then o.amount else -o.amount end else 0 end
    + case when a.id=n.account then case when n.transaction_type='INCOME' then n.amount else -n.amount end else 0 end
    where a.user_id=u and a.id in (o.account,n.account);
  return null;
end $$;
create trigger expense_balance after insert or update or delete on public.tracker_expenses
  for each row execute function tracker_private.expense_balance();

create function tracker_private.transfer_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.tracker_transfers; n public.tracker_transfers; u uuid;
begin
  if tg_op <> 'INSERT' then o := old; end if;
  if tg_op <> 'DELETE' then n := new; end if;
  u := coalesce(n.user_id,o.user_id);
  perform id from public.tracker_accounts where user_id=u and id in (o.from_account,o.to_account,n.from_account,n.to_account) order by id for no key update;
  -- One net update avoids overflow on a no-op reversal/reapplication.
  update public.tracker_accounts a set balance=a.balance
    + case when a.id=o.from_account then o.amount else 0 end
    - case when a.id=o.to_account then o.amount else 0 end
    - case when a.id=n.from_account then n.amount else 0 end
    + case when a.id=n.to_account then n.amount else 0 end
    where a.user_id=u and a.id in (o.from_account,o.to_account,n.from_account,n.to_account);
  return null;
end $$;
create trigger transfer_balance after insert or update or delete on public.tracker_transfers
  for each row execute function tracker_private.transfer_balance();

create function tracker_private.debt_status() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.status := case when new.amount_paid >= new.amount then 'PAID'
    when new.due_date < current_date then 'OVERDUE' when new.amount_paid > 0 then 'PARTIAL' else 'PENDING' end;
  return new;
end $$;
create trigger debt_status before insert or update on public.tracker_money_debts
  for each row execute function tracker_private.debt_status();

create function tracker_private.debt_payment_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.tracker_debt_payments; n public.tracker_debt_payments; u uuid;
begin
  if tg_op <> 'INSERT' then o := old; end if;
  if tg_op <> 'DELETE' then n := new; end if;
  u := coalesce(n.user_id,o.user_id);
  perform id from public.tracker_money_debts where user_id=u and id in (o.debt,n.debt) order by id for no key update;
  update public.tracker_money_debts d set amount_paid=d.amount_paid
    - case when d.id=o.debt then o.amount else 0 end
    + case when d.id=n.debt then n.amount else 0 end
    where d.user_id=u and d.id in (o.debt,n.debt);
  -- The locked row's CHECK rejects overpayment; the entire statement rolls back.
  return null;
end $$;
create trigger debt_payment_balance after insert or update or delete on public.tracker_debt_payments
  for each row execute function tracker_private.debt_payment_balance();

create function tracker_private.card_activity_balance() returns trigger
language plpgsql security definer set search_path = '' as $$
declare o public.tracker_credit_card_activities; n public.tracker_credit_card_activities; u uuid;
  old_delta numeric := 0; new_delta numeric := 0;
begin
  if tg_op <> 'INSERT' then
    o := old;
    old_delta := o.amount * case when o.activity_type='PAYMENT' then -1 when o.activity_type='ADJUSTMENT' then o.adjustment_direction else 1 end;
  end if;
  if tg_op <> 'DELETE' then
    n := new;
    new_delta := n.amount * case when n.activity_type='PAYMENT' then -1 when n.activity_type='ADJUSTMENT' then n.adjustment_direction else 1 end;
  end if;
  u := coalesce(n.user_id,o.user_id);
  perform id from public.tracker_credit_cards where user_id=u and id in (o.card,n.card) order by id for no key update;
  perform id from public.tracker_accounts where user_id=u and id in (o.payment_account,n.payment_account) order by id for no key update;
  update public.tracker_credit_cards c set outstanding=c.outstanding
    - case when c.id=o.card then old_delta else 0 end
    + case when c.id=n.card then new_delta else 0 end
    where c.user_id=u and c.id in (o.card,n.card);
  update public.tracker_accounts a set balance=a.balance
    + case when a.id=o.payment_account then o.amount else 0 end
    - case when a.id=n.payment_account then n.amount else 0 end
    where a.user_id=u and a.id in (o.payment_account,n.payment_account);
  return null;
end $$;
create trigger card_activity_balance after insert or update or delete on public.tracker_credit_card_activities
  for each row execute function tracker_private.card_activity_balance();

create function public.tracker_pay_card(p_card bigint,p_amount numeric,p_account bigint,p_date date default current_date,p_notes text default '')
returns public.tracker_credit_card_activities
language plpgsql security invoker set search_path = '' as $$
declare result public.tracker_credit_card_activities;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  insert into public.tracker_credit_card_activities(card,activity_type,amount,payment_account,date,notes)
    values(p_card,'PAYMENT',p_amount,p_account,p_date,coalesce(p_notes,'')) returning * into result;
  return result;
end $$;

create function public.tracker_process_recurring() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); r public.tracker_recurring_rules; scheduled date; next_date date;
  expense_id bigint; ids bigint[] := '{}'; runs integer;
begin
  if u is null then raise exception 'Authentication required' using errcode='42501'; end if;
  for r in select * from public.tracker_recurring_rules where user_id=u and active and next_run <= current_date
    order by next_run,id for update skip locked loop
    runs := 0;
    while r.active and r.next_run <= current_date and runs < 100 loop
      if r.end_date is not null and r.next_run > r.end_date then r.active := false; exit; end if;
      scheduled := r.next_run;
      insert into public.tracker_expenses(user_id,account,title,amount,transaction_type,category,payment_method,date,notes,is_recurring)
        values(u,r.account,r.title,r.amount,r.transaction_type,r.category,r.payment_method,scheduled,
          coalesce(nullif(r.notes,''),'Recurring transaction'),true) returning id into expense_id;
      ids := array_append(ids,expense_id);
      next_date := (scheduled + case r.frequency
        when 'DAILY' then make_interval(days=>r.interval)
        when 'WEEKLY' then make_interval(days=>7*r.interval)
        when 'YEARLY' then make_interval(years=>r.interval)
        else make_interval(months=>r.interval) end)::date;
      r.last_run := scheduled; r.next_run := next_date; runs := runs + 1;
      if r.end_date is not null and next_date > r.end_date then r.active := false; end if;
    end loop;
    update public.tracker_recurring_rules set last_run=r.last_run,next_run=r.next_run,active=r.active where id=r.id and user_id=u;
    if runs > 0 then
      insert into public.tracker_notifications(user_id,kind,title,message,due_date,action_url,dedupe_key)
        values(u,'RECURRING','Recurring ' || lower(r.transaction_type) || ' added',r.title || ' was added automatically.',
          r.last_run,'/transactions','recurring:' || r.id || ':' || r.last_run)
        on conflict(user_id,dedupe_key) do nothing;
    end if;
  end loop;
  return jsonb_build_object('created_count',cardinality(ids),'transaction_ids',to_jsonb(ids));
end $$;

create function tracker_private.acceptance_time(metadata jsonb,key text) returns timestamptz
language plpgsql set search_path = '' as $$
declare result timestamptz;
begin
  if metadata->>key = 'true' then return statement_timestamp(); end if;
  result := nullif(metadata->>key,'')::timestamptz;
  if not isfinite(result) then return null; end if;
  return result;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end $$;

create function tracker_private.bootstrap_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tracker_profiles(id,name,phone,terms_accepted_at,privacy_accepted_at)
    values(new.id,left(coalesce(new.raw_user_meta_data->>'name',''),150),left(new.raw_user_meta_data->>'phone',20),
      tracker_private.acceptance_time(new.raw_user_meta_data,'terms_accepted_at'),
      tracker_private.acceptance_time(new.raw_user_meta_data,'privacy_accepted_at'));
  insert into public.tracker_accounts(user_id,name,account_type)
    values(new.id,'Primary Bank','BANK'),(new.id,'Personal Cash Vault','CASH');
  insert into public.tracker_assistant_profiles(user_id) values(new.id);
  return new;
end $$;
create trigger tracker_bootstrap_user after insert on auth.users
  for each row execute function tracker_private.bootstrap_user();

revoke all on all functions in schema tracker_private from public,anon,authenticated;
revoke all on function public.tracker_pay_card(bigint,numeric,bigint,date,text) from public,anon;
revoke all on function public.tracker_process_recurring() from public,anon;
grant execute on function public.tracker_pay_card(bigint,numeric,bigint,date,text) to authenticated;
grant execute on function public.tracker_process_recurring() to authenticated;
commit;
