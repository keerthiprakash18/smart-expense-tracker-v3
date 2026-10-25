\set ON_ERROR_STOP on
reset role;
insert into auth.users(id) values('55555555-5555-5555-5555-555555555555'),('66666666-6666-6666-6666-666666666666');
set role authenticated;
set request.jwt.claim.sub='55555555-5555-5555-5555-555555555555';
set request.jwt.claim.aal='aal1';
select id as bank from public.tracker_accounts where account_type='BANK' \gset
select (public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000001','CREATE_EXPENSE','{"amount":"500.00","category":"Transport","title":"Petrol"}',0.9)->'command'->>'id') as expense_cmd \gset
select test.assert((select status='PENDING' and requires_confirmation from public.tracker_assistant_commands where id=:expense_cmd),'assistant expense stages confirmation');
select test.assert((select count(*)=0 from public.tracker_expenses),'pending command makes no ledger change');
select test.assert(public.tracker_assistant_confirm(:expense_cmd)->>'status'='COMPLETED','confirm completes expense');
select test.assert((select balance=-500 from public.tracker_accounts where id=:bank),'assistant expense balance applied once');
select test.assert(public.tracker_assistant_confirm(:expense_cmd)->>'status'='COMPLETED','repeated confirm returns completed command');
select test.assert((select count(*)=1 from public.tracker_expenses),'repeated confirm cannot duplicate expense');
select test.assert((public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000001','CREATE_EXPENSE','{"amount":999,"category":"Food"}',0.9)->'command'->>'id')::bigint=:expense_cmd,'request UUID returns original command even on changed retry payload');
select id as expense from public.tracker_expenses where title='Petrol' \gset

set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
select test.assert((select count(*)=0 from public.tracker_assistant_commands),'other owner cannot read command history');
select test.reject(format('select public.tracker_assistant_confirm(%s)',:expense_cmd),'P0002','other owner cannot confirm command');
select test.reject(format('select public.tracker_assistant_cancel(%s)',:expense_cmd),'P0002','other owner cannot cancel command');
select test.reject($q$insert into public.tracker_assistant_commands(client_request_id,intent) values(gen_random_uuid(),'CREATE_NOTE')$q$,'42501','commands cannot be directly forged');
select test.reject('update public.tracker_assistant_commands set status=''COMPLETED''','42501','command outcomes cannot be directly changed');
select test.reject('delete from public.tracker_assistant_commands','42501','idempotency records cannot be directly deleted');
set request.jwt.claim.sub='55555555-5555-5555-5555-555555555555';
select test.reject('update public.tracker_assistant_commands set safe_payload=''{}''','42501','owner cannot alter stored validated payload');
select test.reject('update public.tracker_assistant_commands set executed_at=now()','42501','owner cannot forge execution timestamp');

select (public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000002','CREATE_EXPENSE','{"amount":500}',0.7)->'command'->>'id') as clarify_cmd \gset
select test.assert((select status='NEEDS_CLARIFICATION' from public.tracker_assistant_commands where id=:clarify_cmd),'missing category requests clarification');
select (public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000003','CREATE_EXPENSE','{"amount":500,"category":"Food","title":"Food"}',0.94,'TEXT',:clarify_cmd)->'command'->>'id') as corrected_cmd \gset
select test.assert((select status='CANCELLED' from public.tracker_assistant_commands where id=:clarify_cmd),'clarification atomically cancels superseded command');
select test.assert(public.tracker_assistant_cancel(:corrected_cmd)->>'status'='CANCELLED','pending command cancellation succeeds');
select test.reject(format('select public.tracker_assistant_confirm(%s)',:corrected_cmd),'55000','cancelled command cannot execute');
select test.reject(format('select public.tracker_assistant_cancel(%s)',:expense_cmd),'55000','completed action cannot be cancelled');
select test.assert((select count(*)=1 from public.tracker_expenses),'cancelled clarification leaves ledger unchanged');
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'DELETE_TRANSACTION','{"category":"Transport","merchant":"Petrol","filter_date":true}')->'command'->>'status'='PENDING','natural unique transaction filters select a preview');
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'DELETE_TRANSACTION','{"category":"Health","merchant":"Missing"}')->'command'->>'status'='NEEDS_CLARIFICATION','missing natural match requests clarification');

select test.assert(public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000004','CREATE_NOTE','{"note_content":"Bring documents tomorrow"}',0.99,'VOICE_APP')->'command'->>'status'='COMPLETED','in-app voice note completes atomically');
select public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000004','CREATE_NOTE','{"note_content":"Duplicate attempt"}',0.99,'VOICE_APP');
select test.assert((select count(*)=1 and bool_and(source='VOICE_APP') from public.tracker_assistant_notes),'repeated note request cannot create duplicate note');

insert into public.tracker_category_budgets(category,amount) values('Transport',1000);
select test.assert((public.tracker_assistant_prepare(gen_random_uuid(),'GET_BALANCE','{}')->'command'->'result'->>'balance')::numeric=-500,'assistant balance is calculated in database');
select test.assert((public.tracker_assistant_prepare(gen_random_uuid(),'GET_CATEGORY_SPENDING','{"category":"Transport"}')->'command'->'result'->>'total')::numeric=500,'assistant category spending uses owned ledger');
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'GET_BUDGET_STATUS','{"category":"Transport"}')->'command'->'result' @> '{"budget":1000,"spent":500,"remaining":500,"percent":50}'::jsonb,'assistant category budget matches ledger');
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'GET_FINANCIAL_SUMMARY','{}')->'command'->'result' @> '{"total":500,"income":0,"net":-500}'::jsonb,'assistant financial summary uses aggregates');
select test.assert((select count(*)=1 from public.tracker_expenses),'read-only insights never create financial rows');
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'COMPARE_SPENDING','{}')->'command'->'result' ?& array['current','previous','delta','percent'],'assistant comparison contract');

select (public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000005','CREATE_INCOME','{"amount":1000,"category":"Salary","title":"Salary"}',0.93)->'command'->>'id') as income_cmd \gset
select test.assert(public.tracker_assistant_confirm(:income_cmd)->>'status'='COMPLETED','income confirms successfully');
update public.tracker_assistant_profiles set quick_add=true,confirmation_mode='SMART';
select test.assert(public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000006','CREATE_INCOME','{"amount":20,"category":"Salary","title":"Bonus"}',0.93)->'command'->>'status'='COMPLETED','opted-in high-confidence low-value quick add works');
select test.assert(public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000007','CREATE_INCOME','{"amount":20,"category":"Salary","title":"Bonus"}',0.93)->'command'->>'status'='PENDING','recent duplicate disables quick add');
update public.tracker_assistant_profiles set confirmation_mode='ALWAYS';
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_EXPENSE','{"amount":5,"category":"Food","title":"Coffee"}',0.99)->'command'->>'status'='PENDING','ALWAYS preference overrides quick add');
select test.assert((select balance=520 from public.tracker_accounts where id=:bank),'quick add and income balances exact');
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'DELETE_TRANSACTION','{"category":"Salary"}')->'command'->>'status'='NEEDS_CLARIFICATION','ambiguous transaction match never selects an arbitrary row');

select (public.tracker_assistant_prepare(gen_random_uuid(),'UPDATE_TRANSACTION',jsonb_build_object('target_transaction_id',:expense,'corrected_amount',550),0.9)->'command'->>'id') as update_cmd \gset
select test.assert(public.tracker_assistant_confirm(:update_cmd)->>'status'='COMPLETED','single transaction correction confirms');
select test.assert((select amount=550 from public.tracker_expenses where id=:expense) and (select balance=470 from public.tracker_accounts where id=:bank),'correction atomically reverses prior amount');
select (public.tracker_assistant_prepare(gen_random_uuid(),'UPDATE_TRANSACTION',jsonb_build_object('target_transaction_id',:expense,'corrected_amount',600),0.9)->'command'->>'id') as stale_cmd \gset
update public.tracker_expenses set amount=551 where id=:expense;
select test.assert(public.tracker_assistant_confirm(:stale_cmd)->>'status'='FAILED','confirmation rejects materially changed preview');
select test.assert((select amount=551 from public.tracker_expenses where id=:expense) and (select balance=469 from public.tracker_accounts where id=:bank),'failed stale confirmation makes no ledger change');
select (public.tracker_assistant_prepare(gen_random_uuid(),'DELETE_TRANSACTION',jsonb_build_object('target_transaction_id',:expense),0.9)->'command'->>'id') as delete_cmd \gset
select test.assert(public.tracker_assistant_confirm(:delete_cmd)->>'status'='COMPLETED','confirmed delete removes exactly selected transaction');
select test.assert((select balance=1020 from public.tracker_accounts where id=:bank),'assistant delete reverses balance');
select test.assert((select "transaction" is null from public.tracker_assistant_commands where id=:expense_cmd),'expense deletion clears history FK without deleting idempotency record');
select test.assert(public.tracker_assistant_confirm(:delete_cmd)->>'status'='COMPLETED','repeated delete confirmation is idempotent');

insert into public.tracker_accounts(name) values('Temporary') returning id as temporary_account \gset
select (public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_EXPENSE',jsonb_build_object('account',:temporary_account,'amount',1,'category','Food'),0.9)->'command'->>'id') as removed_account_cmd \gset
delete from public.tracker_accounts where id=:temporary_account;
select test.assert(public.tracker_assistant_confirm(:removed_account_cmd)->>'status'='FAILED','confirm revalidates account existence and ownership');
select test.assert((select count(*)=2 from public.tracker_expenses),'failed account confirmation adds no expense');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'RUN_SQL','{}')$q$,'22023','arbitrary execution intent rejected');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_EXPENSE','{"amount":-1,"category":"Food"}')$q$,'22023','negative assistant amount rejected');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_EXPENSE','{"amount":"NaN","category":"Food"}')$q$,'23514','NaN assistant amount rejected');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_EXPENSE','{"amount":1,"category":"Food","user_id":"22222222-2222-2222-2222-222222222222"}')$q$,'22023','assistant payload owner override rejected');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'DELETE_TRANSACTION','{"target_snapshot":{}}')$q$,'22023','client cannot forge confirmation snapshot');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_NOTE','{"note_content":"test"}',0.99,'VOICE_WAKE')$q$,'0A000','background wake source explicitly unsupported');
reset role;
select id as bob_account from public.tracker_accounts where user_id='22222222-2222-2222-2222-222222222222' and account_type='BANK' \gset
set role authenticated;
select test.reject(format('select public.tracker_assistant_prepare(gen_random_uuid(),''CREATE_EXPENSE'',''{"account":%s,"amount":1,"category":"Food"}'')',:bob_account),'42501','assistant staging rejects foreign account');

insert into test.saved values('assistant_backup',public.tracker_export_backup());
select test.assert(not (public.tracker_export_backup()->'tables' ? 'tracker_assistant_commands'),'backup excludes execution history');
select (public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_EXPENSE','{"amount":1,"category":"Food"}')->'command'->>'id') as pre_restore_cmd \gset
select public.tracker_restore_backup((select data from test.saved where label='assistant_backup'),true);
select test.assert((select status='CANCELLED' from public.tracker_assistant_commands where id=:pre_restore_cmd),'restore invalidates pending previews atomically');
select test.assert((select status='COMPLETED' and "transaction" is null from public.tracker_assistant_commands where id=:income_cmd),'restore retains completed idempotency record and nulls replaced transaction FK');
select test.assert(public.tracker_assistant_prepare('10000000-0000-0000-0000-000000000005','CREATE_INCOME','{"amount":1000,"category":"Salary","title":"Salary"}',0.93)->>'created'='false','restoring does not allow old request replay');
select test.assert((select count(*)=2 from public.tracker_expenses),'old request after restore never duplicates restored ledger');

reset role;
insert into auth.mfa_factors values('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','55555555-5555-5555-5555-555555555555','verified');
set role authenticated;
select test.assert((select count(*)=0 from public.tracker_assistant_commands),'verified MFA hides assistant history from AAL1');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'GET_BALANCE','{}')$q$,'42501','MFA guards assistant preparation');
select test.reject(format('select public.tracker_assistant_confirm(%s)',:income_cmd),'42501','MFA guards even cached confirmations');
select test.reject(format('select public.tracker_assistant_cancel(%s)',:pre_restore_cmd),'42501','MFA guards cancellations');
set request.jwt.claim.aal='aal2';
select test.assert((select count(*)>0 from public.tracker_assistant_commands),'AAL2 restores owned assistant history');
set request.jwt.claim.sub='44444444-4444-4444-4444-444444444444';
select test.assert(public.tracker_assistant_prepare(gen_random_uuid(),'GET_FINANCIAL_SUMMARY','{}')->'command'->'result' @> '{"total":204,"income":1000,"net":796}'::jsonb,'assistant read totals include the full ledger beyond 1000 rows');

set request.jwt.claim.sub='66666666-6666-6666-6666-666666666666';
insert into storage.objects(bucket_id,name) values('tracker-receipts','66666666-6666-6666-6666-666666666666/stale.jpg');
select test.assert(tracker_private.session_allowed(),'live Auth user passes session existence gate');
reset role;
delete from auth.users where id='66666666-6666-6666-6666-666666666666';
set role authenticated;
select test.assert(not tracker_private.session_allowed(),'deleted user AAL2 JWT fails existence gate');
select test.assert((select count(*)=0 from storage.objects),'deleted user cannot read formerly owned receipt');
select test.reject($q$insert into storage.objects(bucket_id,name) values('tracker-receipts','66666666-6666-6666-6666-666666666666/new.jpg')$q$,'42501','deleted user JWT cannot upload new receipts');
select test.reject('select public.tracker_summary()','42501','deleted user cannot call read RPC');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'CREATE_NOTE','{"note_content":"stale"}')$q$,'42501','deleted user cannot invoke assistant writes');
set request.jwt.claim.aal='aal1';
select test.assert(not tracker_private.session_allowed(),'deleted user AAL1 JWT cannot exploit missing MFA factors');
set role anon;
select test.reject('select * from public.tracker_assistant_commands','42501','anonymous assistant history denied');
select test.reject($q$select public.tracker_assistant_prepare(gen_random_uuid(),'GET_BALANCE','{}')$q$,'42501','anonymous assistant preparation denied');
select test.reject('select public.tracker_assistant_confirm(1)','42501','anonymous assistant confirm denied');
select test.reject('select public.tracker_assistant_cancel(1)','42501','anonymous assistant cancel denied');
reset role;
set request.jwt.claim.sub='';
set request.jwt.claim.aal='';
