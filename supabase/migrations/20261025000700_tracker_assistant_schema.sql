begin;

-- A validly signed but stale JWT must not outlive the Auth user for app access.
create or replace function tracker_private.session_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null
    and exists(select 1 from auth.users u where u.id=auth.uid())
    and (coalesce(auth.jwt()->>'aal','')='aal2'
      or not exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified'))
$$;

alter table public.tracker_expenses add constraint tracker_expenses_owner_id unique(user_id,id);
create table public.tracker_assistant_commands (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  client_request_id uuid not null,
  intent text not null check(intent in ('CREATE_NOTE','CREATE_EXPENSE','CREATE_INCOME','UPDATE_TRANSACTION','DELETE_TRANSACTION',
    'GET_DAILY_SPENDING','GET_WEEKLY_SPENDING','GET_MONTHLY_SPENDING','GET_CATEGORY_SPENDING','GET_SPENDING_SUMMARY',
    'GET_BUDGET','GET_BUDGET_STATUS','GET_BALANCE','GET_FINANCIAL_SUMMARY','COMPARE_SPENDING')),
  safe_payload jsonb not null default '{}' check(jsonb_typeof(safe_payload)='object' and octet_length(safe_payload::text)<=16384),
  result_payload jsonb not null default '{}' check(jsonb_typeof(result_payload)='object'),
  confidence numeric(4,3) not null default 0 check(confidence between 0 and 1),
  status text not null default 'PENDING' check(status in ('PENDING','NEEDS_CLARIFICATION','COMPLETED','CANCELLED','FAILED')),
  requires_confirmation boolean not null default true,
  response_text text not null default '', fingerprint text not null default '',
  "transaction" bigint, executed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(user_id,client_request_id),
  foreign key(user_id,"transaction") references public.tracker_expenses(user_id,id) on delete set null ("transaction")
);
create index tracker_assistant_commands_history on public.tracker_assistant_commands(user_id,created_at desc,id desc);
create index tracker_assistant_commands_pending on public.tracker_assistant_commands(user_id,status,created_at desc);
create index tracker_assistant_commands_transaction on public.tracker_assistant_commands(user_id,"transaction");
create index tracker_assistant_commands_fingerprint on public.tracker_assistant_commands(user_id,fingerprint,created_at desc) where status='COMPLETED';
alter table public.tracker_assistant_commands enable row level security;
create policy owner_select on public.tracker_assistant_commands for select to authenticated using(user_id=(select auth.uid()));
create policy owner_insert on public.tracker_assistant_commands for insert to authenticated with check(user_id=(select auth.uid()));
create policy owner_update on public.tracker_assistant_commands for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
create policy owner_delete on public.tracker_assistant_commands for delete to authenticated using(user_id=(select auth.uid()));
create policy session_assurance on public.tracker_assistant_commands as restrictive for all to authenticated
  using((select tracker_private.session_allowed())) with check((select tracker_private.session_allowed()));
revoke all on public.tracker_assistant_commands from public,anon,authenticated;
revoke all on sequence public.tracker_assistant_commands_id_seq from public,anon,authenticated;
-- Clients may inspect history, but cannot forge command outcomes or erase the
-- idempotency record. All state transitions use the guarded RPCs.
grant select on public.tracker_assistant_commands to authenticated;
create trigger protect_row before insert or update on public.tracker_assistant_commands
  for each row execute function tracker_private.protect_row();
create trigger serialize_user_writes before insert or update or delete on public.tracker_assistant_commands
  for each statement execute function tracker_private.lock_user_writes();

create function tracker_private.serialize_command(c public.tracker_assistant_commands) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('id',c.id,'client_request_id',c.client_request_id,'intent',c.intent,'status',c.status,
    'confidence',c.confidence,'requires_confirmation',c.requires_confirmation,'message',c.response_text,
    'payload',c.safe_payload,'result',c.result_payload,'created_at',c.created_at,'executed_at',c.executed_at)
$$;

create function tracker_private.assistant_money(u uuid,n numeric) returns text
language sql stable set search_path='' as $$
  select coalesce((select currency from public.tracker_profiles where id=u),'₹') || round(coalesce(n,0),2)::text
$$;

create function tracker_private.assistant_query(u uuid,intent text,p jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare start_date date := coalesce((p->>'period_start')::date,date_trunc('month',current_date)::date);
  end_date date := coalesce((p->>'period_end')::date,current_date); period text := coalesce(p->>'period_label','this month');
  category_label text := p->>'category'; total numeric; income numeric; budget numeric; remaining numeric; pct numeric;
  previous numeric; first_day date := date_trunc('month',current_date)::date; prev_start date; prev_end date;
  message text; result jsonb;
begin
  if not isfinite(start_date) or not isfinite(end_date) or start_date>end_date then raise exception 'Invalid assistant date range' using errcode='22023'; end if;
  if intent='GET_BALANCE' then
    select coalesce(sum(balance),0) into total from public.tracker_accounts where user_id=u;
    return jsonb_build_object('message','Your total account balance is ' || tracker_private.assistant_money(u,total) || '.', 'result',jsonb_build_object('balance',total));
  elsif intent in ('GET_BUDGET','GET_BUDGET_STATUS') then
    select b.amount,b.category into budget,category_label from public.tracker_category_budgets b
      where b.user_id=u and b.active and lower(b.category)=lower(p->>'category') order by b.id limit 1;
    if not found then
      select coalesce((select monthly_budget from public.tracker_profiles where id=u),0) into budget;
      category_label := null;
    end if;
    select coalesce(sum(amount),0) into total from public.tracker_expenses e where user_id=u
      and transaction_type in ('EXPENSE','BILL') and date>=first_day and date<first_day+interval '1 month'
      and (category_label is null or lower(e.category)=lower(category_label));
    remaining := greatest(0,budget-total); pct := case when budget>0 then round(total/budget*100,1) else 0 end;
    return jsonb_build_object('message','Your ' || coalesce(category_label,'overall') || ' budget is ' || tracker_private.assistant_money(u,budget)
      || '. You have spent ' || tracker_private.assistant_money(u,total) || ' and ' || tracker_private.assistant_money(u,remaining) || ' remains.',
      'result',jsonb_build_object('category',category_label,'budget',budget,'spent',total,'remaining',remaining,'percent',pct));
  elsif intent='COMPARE_SPENDING' then
    prev_start := (first_day-interval '1 month')::date;
    prev_end := least(first_day-1,prev_start+extract(day from current_date)::int-1);
    select coalesce(sum(amount),0) into total from public.tracker_expenses where user_id=u and transaction_type in ('EXPENSE','BILL') and date between first_day and current_date;
    select coalesce(sum(amount),0) into previous from public.tracker_expenses where user_id=u and transaction_type in ('EXPENSE','BILL') and date between prev_start and prev_end;
    pct := case when previous>0 then round((total-previous)/previous*100,1) else 0 end;
    return jsonb_build_object('message','You have spent ' || tracker_private.assistant_money(u,total) || ' this month, compared with '
      || tracker_private.assistant_money(u,previous) || ' at the same point last month.',
      'result',jsonb_build_object('current',total,'previous',previous,'delta',total-previous,'percent',pct));
  end if;
  select coalesce(sum(amount),0) into total from public.tracker_expenses e where user_id=u
    and transaction_type in ('EXPENSE','BILL') and date between start_date and end_date
    and (intent<>'GET_CATEGORY_SPENDING' or category_label is null or lower(e.category)=lower(category_label));
  result := jsonb_build_object('total',total,'period_start',start_date,'period_end',end_date);
  if category_label is not null then result := result || jsonb_build_object('category',category_label); end if;
  message := 'You spent ' || tracker_private.assistant_money(u,total) || case when intent='GET_CATEGORY_SPENDING' and category_label is not null then ' on ' || category_label else '' end || ' ' || period || '.';
  if intent in ('GET_SPENDING_SUMMARY','GET_FINANCIAL_SUMMARY') then
    select coalesce(sum(amount),0) into income from public.tracker_expenses where user_id=u and transaction_type='INCOME' and date between start_date and end_date;
    result := result || jsonb_build_object('income',income,'net',income-total);
    message := period || ': ' || tracker_private.assistant_money(u,income) || ' income and ' || tracker_private.assistant_money(u,total) || ' spent.';
  end if;
  return jsonb_build_object('message',message,'result',result);
end $$;

revoke all on function tracker_private.serialize_command(public.tracker_assistant_commands),
  tracker_private.assistant_money(uuid,numeric),tracker_private.assistant_query(uuid,text,jsonb) from public,anon,authenticated;
commit;
