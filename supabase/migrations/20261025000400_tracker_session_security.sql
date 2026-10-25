begin;

create function tracker_private.session_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    coalesce(auth.jwt()->>'aal','') = 'aal2'
    or not exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified')
  )
$$;
revoke all on function tracker_private.session_allowed() from public,anon;
grant usage on schema tracker_private to authenticated;
grant execute on function tracker_private.session_allowed() to authenticated;

-- Restrictive policies AND with every permissive owner policy, including future
-- owner-policy additions. An AAL1 token cannot bypass verified MFA via REST.
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' loop
    execute format('create policy session_assurance on public.%I as restrictive for all to authenticated using ((select tracker_private.session_allowed())) with check ((select tracker_private.session_allowed()))',t.tablename);
  end loop;
end $$;
create policy tracker_receipts_assurance on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'tracker-receipts' or (select tracker_private.session_allowed()))
  with check (bucket_id <> 'tracker-receipts' or (select tracker_private.session_allowed()));

-- All user writes acquire this lock BEFORE acquiring row locks. This serializes
-- restore against ordinary CRUD as well as other multi-statement RPCs. It never
-- uses a client-supplied owner or a client-settable bypass flag.
create function tracker_private.lock_user_writes() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null then
    perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,7491));
  end if;
  return null;
end $$;
do $$ declare t record; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' loop
    execute format('create trigger serialize_user_writes before insert or update or delete on public.%I for each statement execute function tracker_private.lock_user_writes()',t.tablename);
  end loop;
end $$;
revoke all on function tracker_private.lock_user_writes() from public,anon,authenticated;

-- Keep the tested recurring implementation private; only this MFA-gated wrapper
-- is callable over the API. The original implementation still checks auth.uid().
alter function public.tracker_process_recurring() set schema tracker_private;
revoke all on function tracker_private.tracker_process_recurring() from public,anon,authenticated;
create function public.tracker_process_recurring() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,7491));
  return tracker_private.tracker_process_recurring();
end $$;
revoke all on function public.tracker_process_recurring() from public,anon;
grant execute on function public.tracker_process_recurring() to authenticated;

create or replace function public.tracker_pay_card(p_card bigint,p_amount numeric,p_account bigint,p_date date default current_date,p_notes text default '')
returns public.tracker_credit_card_activities
language plpgsql security invoker set search_path = '' as $$
declare result public.tracker_credit_card_activities;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  insert into public.tracker_credit_card_activities(card,activity_type,amount,payment_account,date,notes)
    values(p_card,'PAYMENT',p_amount,p_account,p_date,coalesce(p_notes,'')) returning * into result;
  return result;
end $$;

create or replace function tracker_private.bootstrap_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.tracker_profiles(id,name,phone,terms_accepted_at,privacy_accepted_at)
    values(new.id,left(coalesce(new.raw_user_meta_data->>'name',''),150),left(new.raw_user_meta_data->>'phone',20),
      case when new.raw_user_meta_data->'accepted_terms'='true'::jsonb then statement_timestamp()
        else tracker_private.acceptance_time(new.raw_user_meta_data,'terms_accepted_at') end,
      case when new.raw_user_meta_data->'accepted_privacy'='true'::jsonb then statement_timestamp()
        else tracker_private.acceptance_time(new.raw_user_meta_data,'privacy_accepted_at') end);
  insert into public.tracker_accounts(user_id,name,account_type)
    values(new.id,'Primary Bank','BANK'),(new.id,'Personal Cash Vault','CASH');
  insert into public.tracker_assistant_profiles(user_id) values(new.id);
  return new;
end $$;
commit;
