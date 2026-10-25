\set ON_ERROR_STOP on
reset role;
create table test.saved(label text primary key,data jsonb not null);
grant select,insert,update on test.saved to authenticated;
insert into auth.users(id,raw_user_meta_data) values('44444444-4444-4444-4444-444444444444','{"name":"Reports","accepted_terms":true,"accepted_privacy":true}');
select test.assert((select terms_accepted_at is not null and privacy_accepted_at is not null and abs(extract(epoch from terms_accepted_at-now()))<10 from public.tracker_profiles where id='44444444-4444-4444-4444-444444444444'),'signup boolean legal declarations become server timestamps');
select test.assert((select count(*)=17 from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\'),'16 portable app tables plus RPC-only assistant commands');
set role authenticated;
set request.jwt.claim.sub='44444444-4444-4444-4444-444444444444';
set request.jwt.claim.aal='aal1';
select test.assert(tracker_private.session_allowed(),'AAL1 allowed when no verified MFA factor');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::integer=0,'empty summary works');
select test.assert(jsonb_array_length(public.tracker_summary()->'analytics'->'months')=8,'empty analytics contains eight zero-filled months');
select test.assert(public.tracker_summary()->'forecast'->'categories'='[]'::jsonb,'empty forecast categories array');
select id as bank from public.tracker_accounts where account_type='BANK' \gset
select id as cash from public.tracker_accounts where account_type='CASH' \gset
update public.tracker_profiles set monthly_budget=100;
select test.assert((public.tracker_import_expenses((select jsonb_agg(jsonb_build_object('account',:bank,'amount',1,'transaction_type','INCOME','title','Income '||i)) from generate_series(1,1000) i))->>'created')::integer=1000,'atomic CSV import accepts 1000 rows');
select test.assert((public.tracker_import_expenses((select jsonb_agg(jsonb_build_object('account',:bank,'amount',1,'category','Food','title','Food '||i)) from generate_series(1,201) i))->>'created')::integer=201,'second CSV import adds 201 expenses');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::integer=1201,'summary aggregates past PostgREST 1000-row limit');
select test.assert(public.tracker_summary()->'dashboard' @> '{"total_income":1000,"total_expenses":201,"total_bills":0,"net_balance":799,"account_balance":799,"count":1201}'::jsonb,'dashboard exact ledger aggregates');
select test.assert(public.tracker_summary()->'analytics'->'totals' @> '{"income":1000,"spend":201,"average_spend":1,"net":799,"transaction_count":1201}'::jsonb,'analytics exact full-ledger totals');
select test.assert(public.tracker_summary()->'analytics'->'month' @> '{"income":1000,"spend":201,"budget":100,"budget_percent":201,"categories":[{"name":"Food","value":201}]}'::jsonb,'analytics current month categories and budget shape');
select test.assert((select array_agg(k order by k)=array['account_balance','borrowed_remaining','count','lent_remaining','monthly_budget','net_balance','ocr_scanned_count','savings_current','total_bills','total_expenses','total_income','unpaid_bills'] from jsonb_object_keys(public.tracker_summary()->'dashboard') k),'dashboard exposes exactly original Django keys');
select test.assert((select array_agg(k order by k)=array['generated_at','month','months','totals'] from jsonb_object_keys(public.tracker_summary()->'analytics') k),'analytics exposes exactly original Django keys');
select test.assert(jsonb_typeof(public.tracker_summary()->'forecast'->'categories'->0->'spent')='string','forecast money remains decimal strings');
select test.assert(public.tracker_summary()->'insights' ?& array['generated_at','insights'],'insights original response wrapper');

select test.reject($q$select public.tracker_import_expenses('[{"amount":2},{"amount":0}]')$q$,'23514','CSV invalid later row rejects whole batch');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::int=1201,'CSV failed batch leaves zero partial rows');
select test.reject($q$select public.tracker_import_expenses('[{"amount":1,"id":88}]')$q$,'22023','CSV ID override rejected');
select test.reject($q$select public.tracker_import_expenses('[{"amount":1,"user_id":"22222222-2222-2222-2222-222222222222"}]')$q$,'22023','CSV owner override rejected');
select test.reject($q$select public.tracker_import_expenses('[{"amount":1,"created_at":"2000-01-01"}]')$q$,'22023','CSV timestamp override rejected');
select test.reject($q$select public.tracker_import_expenses('[{"amount":1,"unexpected":true}]')$q$,'22023','CSV unknown field rejected');
select test.reject($q$select public.tracker_import_expenses((select jsonb_agg(jsonb_build_object('amount',1)) from generate_series(1,1001)))$q$,'22023','CSV 1001-row bound enforced');
select test.reject($q$select public.tracker_import_expenses(jsonb_build_array(jsonb_build_object('amount',1,'notes',repeat('x',2097153))))$q$,'22023','CSV byte bound enforced');
select test.reject($q$select public.tracker_import_expenses('{}')$q$,'22023','CSV non-array rejected');
reset role;
select id as bob_account from public.tracker_accounts where user_id='22222222-2222-2222-2222-222222222222' and account_type='BANK' \gset
set role authenticated;
select test.reject(format('select public.tracker_import_expenses(''[{"amount":2},{"account":%s,"amount":1}]'')',:bob_account),'23503','CSV cross-owner account fails entire batch');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::int=1201,'cross-owner CSV import leaves no first-row side effect');

insert into public.tracker_accounts(name,balance) values('Opening Balance',1234);
insert into public.tracker_category_budgets(category,amount) values('Food',100);
insert into public.tracker_bills(title,amount,due_date) values('Due bill',90,current_date);
insert into public.tracker_savings_goals(name,target_amount,current_amount) values('Goal',100,20);
insert into public.tracker_categories(name) values('Backup category');
insert into public.tracker_recurring_rules(title,amount,account,next_run) values('On demand',7,:bank,current_date);
insert into public.tracker_assistant_notes(content,reminder_at) values('Backup note',now()+interval '1 day');
update public.tracker_assistant_profiles set language='TA',quick_add=true;
insert into public.tracker_money_debts(direction,person_name,amount) values('LENT','Backup debt',100) returning id as debt \gset
insert into public.tracker_debt_payments(debt,amount) values(:debt,40);
insert into public.tracker_credit_cards(name,outstanding,linked_account,due_day)
 values('Backup card',200,:bank,case when extract(day from current_date)>28 then 1 else extract(day from current_date)::int end) returning id as card \gset
insert into public.tracker_credit_card_activities(card,activity_type,amount) values(:card,'PURCHASE',75);
select public.tracker_pay_card(:card,50,:bank,current_date,'Roundtrip payment');
insert into public.tracker_credit_card_activities(card,activity_type,amount,adjustment_direction) values(:card,'ADJUSTMENT',25,-1);
insert into public.tracker_transfers(from_account,to_account,amount) values(:bank,:cash,10);
insert into public.tracker_expenses(account,title,amount,receipt_image) values(:bank,'Receipt',3,'44444444-4444-4444-4444-444444444444/receipt.jpg');
insert into storage.objects(bucket_id,name) values('tracker-receipts','44444444-4444-4444-4444-444444444444/receipt.jpg');
select test.assert((public.tracker_sync_notifications()->>'created')::int=3,'sync creates bill budget and card alerts');
select test.assert((public.tracker_sync_notifications()->>'created')::int=0,'notification sync is idempotent');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::int=1202,'notification sync does not implicitly process recurring rules');
update public.tracker_profiles set bill_reminders=false,budget_alerts=false;
insert into public.tracker_bills(title,amount,due_date) values('Muted bill',10,current_date);
select test.assert((public.tracker_sync_notifications()->>'created')::int=0,'notification sync respects reminder preferences');
update public.tracker_profiles set bill_reminders=true,budget_alerts=true;
select test.assert((public.tracker_sync_notifications()->>'created')::int=1,'reenabled reminder produces one new alert');
select test.assert((public.tracker_summary()->'forecast'->'categories'->0->>'over_budget')::boolean,'forecast identifies over-budget category');

insert into test.saved values('backup',public.tracker_export_backup()),('summary',public.tracker_summary()),
 ('legal',(select jsonb_build_object('terms',terms_accepted_at,'privacy',privacy_accepted_at) from public.tracker_profiles));
select test.assert((select data->>'format'='smart-expense-supabase-v1' and jsonb_array_length(data->'tables'->'tracker_expenses')=1202 from test.saved where label='backup'),'backup exports full ledger in new format');
select test.assert((select not (data->'tables'->'tracker_accounts'->0 ?| array['user_id','created_at','updated_at']) from test.saved where label='backup'),'backup omits ownership and audit timestamps');
select test.assert((public.tracker_restore_backup((select data from test.saved where label='backup'),true)->>'restored')::boolean,'atomic backup roundtrip succeeds');
select test.assert(public.tracker_summary()->'dashboard'=(select data->'dashboard' from test.saved where label='summary'),'restore preserves all dashboard totals without double counting');
select test.assert(((public.tracker_summary()->'analytics')-'generated_at')=(select (data->'analytics')-'generated_at' from test.saved where label='summary'),'restore preserves all analytics data');
select test.assert(public.tracker_summary()->'forecast'=(select data->'forecast' from test.saved where label='summary'),'restore preserves forecast');
select test.assert((select jsonb_build_object('terms',terms_accepted_at,'privacy',privacy_accepted_at)=(select data from test.saved where label='legal') from public.tracker_profiles),'restore preserves legal acceptance timestamps');
select test.assert((select min(id)>:cash from public.tracker_accounts),'restore generates new parent IDs');
select test.assert((select count(*)=1202 from public.tracker_expenses e join public.tracker_accounts a on a.id=e.account and a.user_id=e.user_id where a.name='Primary Bank'),'expense account IDs mapped correctly');
select test.assert((select count(*)=1 from public.tracker_transfers t join public.tracker_accounts a on a.id=t.from_account join public.tracker_accounts b on b.id=t.to_account where a.name='Primary Bank' and b.name='Personal Cash Vault'),'transfer source and target IDs mapped correctly');
select test.assert((select count(*)=1 from public.tracker_debt_payments p join public.tracker_money_debts d on d.id=p.debt where d.person_name='Backup debt' and d.amount_paid=40),'debt IDs and counters restored');
select test.assert((select count(*)=1 from public.tracker_credit_card_activities c join public.tracker_credit_cards card on card.id=c.card join public.tracker_accounts a on a.id=c.payment_account where c.activity_type='PAYMENT' and card.name='Backup card' and a.name='Primary Bank' and card.outstanding=200),'card and payment account IDs mapped correctly');
select test.assert((select count(*)=1 from public.tracker_recurring_rules r join public.tracker_accounts a on a.id=r.account where a.name='Primary Bank'),'recurring account IDs mapped correctly');
select test.assert((select balance=1234 from public.tracker_accounts where name='Opening Balance'),'opening balances survive full ledger replay');
select test.assert((public.tracker_sync_notifications()->>'created')::int=0,'restore remaps notification dedupe IDs and prevents duplicate alerts');
do $$ declare t text; before_count int; after_count int; begin
  for t in select jsonb_object_keys(data->'tables') from test.saved where label='backup' loop
    select jsonb_array_length(data->'tables'->t) into before_count from test.saved where label='backup';
    execute format('select count(*) from public.%I',t) into after_count;
    perform test.assert(before_count=after_count,t || ': backup preserves row count');
  end loop;
end $$;

-- Save post-roundtrip identity too: failed restores must preserve existing IDs,
-- not just coincidentally reconstruct equal totals after a partial replacement.
insert into test.saved values('after',public.tracker_export_backup());
select test.reject($q$select public.tracker_restore_backup((select data from test.saved where label='backup'),false)$q$,'22023','restore requires explicit confirmation');
select test.reject($q$select public.tracker_restore_backup('{"version":3}',true)$q$,'22023','legacy Django/Railway backup rejected');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{owner_id}','"22222222-2222-2222-2222-222222222222"') from test.saved where label='backup'),true)$q$,'42501','another owner backup rejected');
select test.reject($q$select public.tracker_restore_backup((select data#-'{tables,tracker_bills}' from test.saved where label='backup'),true)$q$,'22023','missing backup table rejected');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{tables,tracker_expenses,0,user_id}','"22222222-2222-2222-2222-222222222222"') from test.saved where label='backup'),true)$q$,'22023','backup row owner injection rejected');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{tables,tracker_expenses,1001,amount}','0') from test.saved where label='backup'),true)$q$,'23514','invalid later restore expense aborts entire restore');
select test.assert((public.tracker_export_backup()-'exported_at')=(select data-'exported_at' from test.saved where label='after'),'invalid restore preserves every prior row and ID');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{tables,tracker_expenses,0,account}','999999999') from test.saved where label='backup'),true)$q$,'22023','unknown backup reference rejected');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{tables,tracker_money_debts,0,amount_paid}','99') from test.saved where label='backup'),true)$q$,'22023','forged backup debt counter rejected');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{tables,tracker_accounts,1,id}',data#>'{tables,tracker_accounts,0,id}') from test.saved where label='backup'),true)$q$,'22023','duplicate backup identity rejected');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{tables,tracker_accounts}',(select jsonb_agg(jsonb_build_object('id',i)) from generate_series(1,20001) i)) from test.saved where label='backup'),true)$q$,'22023','backup row limit enforced');
select test.reject($q$select public.tracker_restore_backup((select jsonb_set(data,'{exported_at}',to_jsonb(repeat('x',10485761))) from test.saved where label='backup'),true)$q$,'22023','backup byte limit enforced');
select test.assert((public.tracker_export_backup()-'exported_at')=(select data-'exported_at' from test.saved where label='after'),'all rejected restores leave complete state intact');

-- MFA enrollment itself is managed by Auth, never by an app table or client flag.
reset role;
insert into auth.mfa_factors values('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','44444444-4444-4444-4444-444444444444','unverified');
set role authenticated;
select test.assert(tracker_private.session_allowed(),'unverified factor does not lock out first enrollment');
reset role;
update auth.mfa_factors set status='verified' where user_id='44444444-4444-4444-4444-444444444444';
set role authenticated;
select test.assert(not tracker_private.session_allowed(),'verified factor blocks stale AAL1 token');
do $$ declare t record; n int; col text; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' and tablename<>'tracker_assistant_commands' loop
    execute format('select count(*) from public.%I',t.tablename) into n;
    perform test.assert(n=0,t.tablename || ': AAL1 cannot read own rows after MFA enrollment');
    execute format('delete from public.%I',t.tablename); get diagnostics n=row_count;
    perform test.assert(n=0,t.tablename || ': AAL1 cannot delete own rows');
    select column_name into col from information_schema.column_privileges where table_schema='public' and table_name=t.tablename and grantee='authenticated' and privilege_type='UPDATE' order by column_name limit 1;
    execute format('update public.%I set %I=%I',t.tablename,col,col); get diagnostics n=row_count;
    perform test.assert(n=0,t.tablename || ': AAL1 cannot update own rows');
  end loop;
end $$;
select test.reject('insert into public.tracker_accounts(name) values(''MFA bypass'')','42501','MFA denies direct insertion');
select test.reject('select public.tracker_summary()','42501','MFA gates summary');
select test.reject('select public.tracker_process_recurring()','42501','MFA gates definer recurring RPC');
select test.reject('select public.tracker_sync_notifications()','42501','MFA gates definer notification RPC');
select test.reject('select public.tracker_pay_card(1,1,1,current_date,'''')','42501','MFA gates card RPC');
select test.reject('select public.tracker_import_expenses(''[{"amount":1}]'')','42501','MFA gates atomic CSV RPC');
select test.reject('select public.tracker_export_backup()','42501','MFA gates export RPC');
select test.reject($q$select public.tracker_restore_backup((select data from test.saved where label='backup'),true)$q$,'42501','MFA gates definer restore RPC');
select test.reject('select tracker_private.tracker_process_recurring()','42501','private original recurring implementation cannot bypass MFA');
select test.reject('select * from auth.mfa_factors','42501','MFA factors not exposed by helper grants');
select test.assert((select count(*)=0 from storage.objects),'MFA hides receipt objects');
do $$ declare n int; begin
  update storage.objects set name=name; get diagnostics n=row_count;
  perform test.assert(n=0,'MFA denies receipt updates');
  delete from storage.objects; get diagnostics n=row_count;
  perform test.assert(n=0,'MFA denies receipt deletions');
end $$;
select test.reject($q$insert into storage.objects(bucket_id,name) values('tracker-receipts','44444444-4444-4444-4444-444444444444/bypass.jpg')$q$,'42501','MFA denies receipt insertion');
set request.jwt.claim.aal='aal2';
select test.assert(tracker_private.session_allowed(),'AAL2 passes verified MFA gate');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::int=1202,'AAL2 restores full owner access');
select test.assert((select count(*)=1 from storage.objects),'AAL2 restores receipt access');
select test.assert((public.tracker_export_backup()-'exported_at')=(select data-'exported_at' from test.saved where label='after'),'blocked MFA operations made no changes');
set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
set request.jwt.claim.aal='aal1';
select test.assert(tracker_private.session_allowed(),'another users MFA factor does not restrict this user');
select test.assert((public.tracker_summary()->'dashboard'->>'count')::int=0,'summary scopes all aggregates to caller');
set role anon;
select test.reject('select public.tracker_summary()','42501','anonymous summary forbidden');
select test.reject('select public.tracker_sync_notifications()','42501','anonymous notification sync forbidden');
select test.reject('select public.tracker_import_expenses(''[]'')','42501','anonymous import forbidden');
select test.reject('select public.tracker_export_backup()','42501','anonymous export forbidden');
select test.reject('select public.tracker_restore_backup(''{}'',true)','42501','anonymous restore forbidden');
reset role;
set request.jwt.claim.sub='';
set request.jwt.claim.aal='';
