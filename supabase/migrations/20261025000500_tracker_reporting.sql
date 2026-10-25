begin;

create function public.tracker_summary() returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  u uuid := auth.uid(); first_day date := date_trunc('month',current_date)::date;
  next_month date := (date_trunc('month',current_date)+interval '1 month')::date;
  days_elapsed integer := extract(day from current_date); days_in_month integer;
  totals record; budget numeric; categories jsonb; months jsonb; projections jsonb;
  dashboard jsonb; analytics jsonb; insights jsonb := '[]'; r record; pct numeric; subscriptions numeric;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  days_in_month := extract(day from next_month-1);
  select coalesce(sum(amount) filter(where transaction_type='INCOME'),0) as income,
    coalesce(sum(amount) filter(where transaction_type='EXPENSE'),0) as expenses,
    coalesce(sum(amount) filter(where transaction_type='BILL'),0) as bills,
    coalesce(avg(amount) filter(where transaction_type in ('EXPENSE','BILL')),0) as average_spend,
    count(*) as count, count(*) filter(where coalesce(receipt_image,'')<>'') as ocr_count,
    coalesce(sum(amount) filter(where transaction_type='INCOME' and date>=first_day and date<next_month),0) as month_income,
    coalesce(sum(amount) filter(where transaction_type in ('EXPENSE','BILL') and date>=first_day and date<next_month),0) as month_spend,
    coalesce(sum(amount) filter(where transaction_type='INCOME' and date between first_day and current_date),0) as mtd_income,
    coalesce(sum(amount) filter(where transaction_type in ('EXPENSE','BILL') and date between first_day and current_date),0) as mtd_spend,
    coalesce(sum(amount) filter(where transaction_type in ('EXPENSE','BILL') and date>=first_day-interval '1 month' and date<first_day),0) as previous_spend
    into totals from public.tracker_expenses where user_id=u;
  select coalesce((select monthly_budget from public.tracker_profiles where id=u),0) into budget;
  dashboard := jsonb_build_object(
    'total_income',totals.income,'total_expenses',totals.expenses,'total_bills',totals.bills,
    'net_balance',totals.income-totals.expenses-totals.bills,
    'account_balance',(select coalesce(sum(balance),0) from public.tracker_accounts where user_id=u),
    'count',totals.count,'ocr_scanned_count',totals.ocr_count,'monthly_budget',budget,
    'borrowed_remaining',(select coalesce(sum(amount-amount_paid),0) from public.tracker_money_debts where user_id=u and direction='BORROWED'),
    'lent_remaining',(select coalesce(sum(amount-amount_paid),0) from public.tracker_money_debts where user_id=u and direction='LENT'),
    'unpaid_bills',(select coalesce(sum(amount),0) from public.tracker_bills where user_id=u and not is_paid),
    'savings_current',(select coalesce(sum(current_amount),0) from public.tracker_savings_goals where user_id=u));
  select coalesce(jsonb_agg(jsonb_build_object('name',coalesce(nullif(category,''),'General'),'value',spent) order by spent desc,category),'[]')
    into categories from (select category,sum(amount) spent from public.tracker_expenses where user_id=u
      and transaction_type in ('EXPENSE','BILL') and date>=first_day and date<next_month group by category) q;
  select jsonb_agg(jsonb_build_object('key',to_char(month_start,'YYYY-MM'),'label',to_char(month_start,'Mon YY'),
    'income',income,'spend',spend,'net',income-spend) order by month_start) into months
  from (select m.month_start,coalesce(sum(e.amount) filter(where e.transaction_type='INCOME'),0) income,
      coalesce(sum(e.amount) filter(where e.transaction_type in ('EXPENSE','BILL')),0) spend
    from (select (first_day-make_interval(months=>i))::date month_start from generate_series(7,0,-1) i) m
    left join public.tracker_expenses e on e.user_id=u and e.date>=m.month_start and e.date<m.month_start+interval '1 month'
    group by m.month_start) q;
  analytics := jsonb_build_object('month',jsonb_build_object('income',totals.month_income,'spend',totals.month_spend,
      'budget',budget,'budget_percent',case when budget>0 then round(totals.month_spend/budget*100,1) else 0 end,'categories',categories),
    'totals',jsonb_build_object('income',totals.income,'spend',totals.expenses+totals.bills,'average_spend',totals.average_spend,
      'net',totals.income-totals.expenses-totals.bills,'transaction_count',totals.count),
    'months',months,'generated_at',statement_timestamp());

  select coalesce(jsonb_agg(jsonb_build_object('category',category,'spent',round(spent,2)::text,
      'projected',projected::text,'budget',case when category_budget is not null then category_budget::text else null end,
      'over_budget',coalesce(projected>category_budget,false),'daily_rate',round(spent/days_elapsed,2)::text)
    || case when projected>category_budget then jsonb_build_object('pace',round(spent/category_budget,2),'message',
      case when spent>=category_budget then category || ' has already crossed its ' || category_budget || ' budget by ' || round(spent-category_budget,2) || '.'
        else 'At this pace ' || category || ' will reach about ' || projected || ' by month end, over your ' || category_budget || ' budget. Slowing down now saves ' || round(projected-category_budget,2) || '.' end)
      else '{}'::jsonb end order by coalesce(projected>category_budget,false) desc,category),'[]') into projections
    from (select s.category,s.spent,round(s.spent/days_elapsed*days_in_month,2) projected,b.amount category_budget
      from (select coalesce(nullif(category,''),'General') category,sum(amount) spent from public.tracker_expenses
        where user_id=u and transaction_type in ('EXPENSE','BILL') and date>=first_day and date<next_month
        group by coalesce(nullif(category,''),'General')) s
      left join public.tracker_category_budgets b on b.user_id=u and b.active and b.category=s.category) q;

  if totals.previous_spend>0 then
    pct := (totals.mtd_spend-totals.previous_spend)/totals.previous_spend*100;
    insights := insights || jsonb_build_array(jsonb_build_object('kind','trend','title','Monthly spending trend','message',
      'Spending is ' || round(abs(pct)) || '% ' || case when pct>0 then 'higher' else 'lower' end || ' than last month.'));
  end if;
  if totals.mtd_income>0 then
    insights := insights || jsonb_build_array(jsonb_build_object('kind','cashflow','title','Savings rate','message',
      'Your current-month savings rate is ' || round((totals.mtd_income-totals.mtd_spend)/totals.mtd_income*100) || '%.'));
  end if;
  select category,sum(amount) spent into r from public.tracker_expenses where user_id=u and transaction_type in ('EXPENSE','BILL')
    and date between first_day and current_date group by category order by sum(amount) desc,category limit 1;
  if found then insights := insights || jsonb_build_array(jsonb_build_object('kind','category','title','Top spending category',
    'message',r.category || ' is your largest category this month at ' || r.spent || '.')); end if;
  select coalesce(sum(amount),0) into subscriptions from public.tracker_recurring_rules where user_id=u and active and transaction_type in ('EXPENSE','BILL');
  if subscriptions>0 then insights := insights || jsonb_build_array(jsonb_build_object('kind','recurring','title','Recurring commitments',
    'message','Active recurring expenses total about ' || subscriptions || ' per cycle.')); end if;
  for r in select b.category,b.amount,coalesce(sum(e.amount),0) spent from public.tracker_category_budgets b
    left join public.tracker_expenses e on e.user_id=u and lower(e.category)=lower(b.category)
      and e.transaction_type in ('EXPENSE','BILL') and e.date between first_day and current_date
    where b.user_id=u and b.active group by b.id having coalesce(sum(e.amount),0)>=b.amount*0.8 order by b.category loop
    insights := insights || jsonb_build_array(jsonb_build_object('kind','budget','title',r.category || ' budget alert',
      'message','You have used ' || round(r.spent/r.amount*100) || '% of this category budget.'));
  end loop;
  select coalesce(jsonb_agg(value),'[]') into insights from (select value from jsonb_array_elements(insights) limit 8) q;
  return jsonb_build_object('dashboard',dashboard,'analytics',analytics,
    'insights',jsonb_build_object('generated_at',statement_timestamp(),'insights',insights),
    'forecast',jsonb_build_object('days_elapsed',days_elapsed,'days_left',days_in_month-days_elapsed,
      'days_in_month',days_in_month,'categories',projections));
end $$;

create function public.tracker_sync_notifications() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare u uuid := auth.uid(); created integer := 0; n integer; first_day date := date_trunc('month',current_date)::date;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));
  insert into public.tracker_notifications(user_id,kind,title,message,due_date,action_url,dedupe_key)
    select u,'BILL',case when b.due_date<current_date then 'Overdue' else 'Upcoming' end || ' bill: ' || left(b.title,140),
      b.title || ' is ' || case when b.due_date<current_date then 'overdue' else 'due soon' end || ' — amount ' || b.amount || '.',
      b.due_date,'/money','bill:' || b.id || ':' || b.due_date
    from public.tracker_bills b join public.tracker_profiles p on p.id=u and p.bill_reminders
    where b.user_id=u and not b.is_paid and b.due_date<=current_date+5 on conflict(user_id,dedupe_key) do nothing;
  get diagnostics n = row_count; created := created+n;
  insert into public.tracker_notifications(user_id,kind,title,message,action_url,dedupe_key)
    select u,'BUDGET',category || ' budget ' || level || ' reached',
      'You have spent ' || spent || ' of ' || amount || ' this month.','/planner',
      'budget:' || id || ':' || extract(year from current_date)::int || '-' || extract(month from current_date)::int || ':' || level
    from (select b.id,b.category,b.amount,sum(e.amount) spent,case when sum(e.amount)>=b.amount then 'limit' else '80%' end level
      from public.tracker_category_budgets b join public.tracker_profiles p on p.id=u and p.budget_alerts
      join public.tracker_expenses e on e.user_id=u and lower(e.category)=lower(b.category)
        and e.transaction_type in ('EXPENSE','BILL') and e.date>=first_day and e.date<first_day+interval '1 month'
      where b.user_id=u and b.active group by b.id having sum(e.amount)>=b.amount*0.8) q
    on conflict(user_id,dedupe_key) do nothing;
  get diagnostics n = row_count; created := created+n;
  insert into public.tracker_notifications(user_id,kind,title,message,due_date,action_url,dedupe_key)
    select u,'CARD',name || ' payment due','Outstanding ' || outstanding || ' is due by ' || due || '.',due,'/planner',
      'card:' || id || ':' || due
    from (select id,name,outstanding,case when first_day+due_day-1<current_date
      then (first_day+interval '1 month')::date+due_day-1 else first_day+due_day-1 end due
      from public.tracker_credit_cards where user_id=u and active and outstanding>0) q
    where due<=current_date+5 on conflict(user_id,dedupe_key) do nothing;
  get diagnostics n = row_count; created := created+n;
  return jsonb_build_object('created',created,'unread',(select count(*) from public.tracker_notifications where user_id=u and not is_read));
end $$;

revoke all on function public.tracker_summary() from public,anon;
revoke all on function public.tracker_sync_notifications() from public,anon;
grant execute on function public.tracker_summary(),public.tracker_sync_notifications() to authenticated;
commit;
