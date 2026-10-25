\set ON_ERROR_STOP on
insert into auth.users(id,raw_user_meta_data) values
 ('11111111-1111-1111-1111-111111111111','{"name":"Alice","phone":"123","terms_accepted_at":"2026-10-25T00:00:00Z","privacy_accepted_at":true}'),
 ('22222222-2222-2222-2222-222222222222','{"name":"Bob"}');
select test.assert((select count(*)=4 from public.tracker_accounts),'bootstrap creates two zero-balance default accounts per user');
select test.assert((select name='Alice' and phone='123' and terms_accepted_at is not null and privacy_accepted_at is not null from public.tracker_profiles where id='11111111-1111-1111-1111-111111111111'),'profile bootstrap metadata');
select test.assert((select bool_and(balance=0) from public.tracker_accounts),'fresh data has zero opening balances');

set role authenticated;
set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
insert into public.tracker_money_debts(direction,person_name,amount) values('LENT','Bob debt',100);
insert into public.tracker_credit_cards(name,outstanding) values('Bob card',100);
insert into storage.objects(bucket_id,name) values('tracker-receipts','22222222-2222-2222-2222-222222222222/bob.jpg');

set request.jwt.claim.sub='11111111-1111-1111-1111-111111111111';
select test.assert((select count(*)=2 from public.tracker_accounts),'owner reads only own accounts');
select test.assert((select count(*)=1 from public.tracker_profiles),'owner reads only own profile');
select test.assert((select count(*)=0 from public.tracker_credit_cards),'other user cards hidden');
select test.reject($q$insert into public.tracker_accounts(user_id,name) values('22222222-2222-2222-2222-222222222222','Spoof')$q$,'42501','spoofed user_id denied');
select test.reject($q$update public.tracker_accounts set user_id='22222222-2222-2222-2222-222222222222'$q$,'42501','owner mutation denied');
select test.reject($q$update public.tracker_accounts set balance=999$q$,'42501','direct computed balance update denied');
select test.reject($q$update public.tracker_accounts set created_at=now()-interval '1 year'$q$,'42501','timestamp update denied');
select test.reject($q$insert into public.tracker_accounts(name,created_at) values('Forged',now())$q$,'42501','timestamp insert denied');
select test.reject($q$update public.tracker_profiles set terms_accepted_at=now()$q$,'42501','legal acceptance timestamp protected');
select test.reject($q$insert into public.tracker_accounts(name,balance) values('NaN','NaN')$q$,'23514','NaN rejected');
select test.reject($q$insert into public.tracker_accounts(name,balance) values('Infinity','Infinity')$q$,'22003,23514','infinite money rejected');
select test.reject($q$insert into public.tracker_expenses(amount) values(0)$q$,'23514','zero expense rejected');
select test.reject($q$insert into public.tracker_expenses(amount,date) values(1,'infinity')$q$,'23514','infinite date rejected');
select test.reject($q$insert into public.tracker_expenses(amount,transaction_type) values(1,'TRANSFER')$q$,'23514','transfer cannot double count as expense');
select test.reject($q$insert into public.tracker_expenses(amount,time) values(1,'25:00')$q$,'23514','invalid time rejected');

-- Known IDs are captured as the cluster owner, then tested under the real role.
reset role;
select id as bob_account from public.tracker_accounts where user_id='22222222-2222-2222-2222-222222222222' and account_type='BANK' \gset
select id as bob_debt from public.tracker_money_debts where person_name='Bob debt' \gset
select id as bob_card from public.tracker_credit_cards where name='Bob card' \gset
set role authenticated;
select id as bank from public.tracker_accounts where account_type='BANK' \gset
select id as cash from public.tracker_accounts where account_type='CASH' \gset
select test.reject(format('insert into public.tracker_expenses(account,amount) values(%s,1)',:bob_account),'23503','cross-owner expense account rejected');
select test.reject(format('insert into public.tracker_transfers(from_account,to_account,amount) values(%s,%s,1)',:bank,:bob_account),'23503','cross-owner transfer rejected');
select test.reject(format('insert into public.tracker_recurring_rules(title,amount,account) values(''bad'',1,%s)',:bob_account),'23503','cross-owner recurring account rejected');
select test.reject(format('insert into public.tracker_credit_cards(name,linked_account) values(''bad'',%s)',:bob_account),'23503','cross-owner linked card account rejected');
select test.reject(format('insert into public.tracker_debt_payments(debt,amount) values(%s,1)',:bob_debt),'23503','cross-owner debt rejected');
select test.reject(format('insert into public.tracker_credit_card_activities(card,activity_type,amount) values(%s,''PURCHASE'',1)',:bob_card),'23503','cross-owner card rejected');
select test.assert((select balance=0 from public.tracker_accounts where id=:bank),'cross-owner failures roll back account effects');

insert into public.tracker_expenses(account,title,amount,transaction_type) values(:bank,'Salary',1000,'INCOME') returning id as salary \gset
insert into public.tracker_expenses(account,title,amount) values(:bank,'Lunch',100) returning id as lunch \gset
select test.assert((select balance=900 from public.tracker_accounts where id=:bank),'income adds and expense subtracts');
update public.tracker_expenses set amount=150 where id=:lunch;
select test.assert((select balance=850 from public.tracker_accounts where id=:bank),'expense edit adjusts only difference');
update public.tracker_expenses set account=:cash,transaction_type='INCOME',amount=25 where id=:lunch;
select test.assert((select balance=1000 from public.tracker_accounts where id=:bank) and (select balance=25 from public.tracker_accounts where id=:cash),'account and transaction type edit reverses old and applies new');
delete from public.tracker_expenses where id=:lunch;
select test.assert((select balance=0 from public.tracker_accounts where id=:cash),'expense deletion reverses balance');
insert into public.tracker_expenses(amount,title) values(5,'Unassigned') returning id as unassigned \gset
update public.tracker_expenses set account=:bank where id=:unassigned;
select test.assert((select balance=995 from public.tracker_accounts where id=:bank),'assigning previously null account subtracts');
update public.tracker_expenses set account=null where id=:unassigned;
select test.assert((select balance=1000 from public.tracker_accounts where id=:bank),'removing account reverses expense');
insert into public.tracker_expenses(account,amount,transaction_type) values(:bank,40,'BILL') returning id as bill_expense \gset
select test.assert((select balance=960 from public.tracker_accounts where id=:bank),'bill expense subtracts');
delete from public.tracker_expenses where id=:bill_expense;

insert into public.tracker_transfers(from_account,to_account,amount) values(:bank,:cash,200) returning id as transfer \gset
select test.assert((select balance=800 from public.tracker_accounts where id=:bank) and (select balance=200 from public.tracker_accounts where id=:cash),'transfer applies both legs atomically');
update public.tracker_transfers set amount=300 where id=:transfer;
select test.assert((select balance=700 from public.tracker_accounts where id=:bank) and (select balance=300 from public.tracker_accounts where id=:cash),'transfer edit reverses old legs');
select test.reject(format('update public.tracker_transfers set to_account=%s where id=%s',:bob_account,:transfer),'23503','invalid transfer edit rejected');
select test.assert((select balance=700 from public.tracker_accounts where id=:bank) and (select balance=300 from public.tracker_accounts where id=:cash),'invalid transfer edit leaves both balances unchanged');
delete from public.tracker_transfers where id=:transfer;
select test.assert((select balance=1000 from public.tracker_accounts where id=:bank) and (select balance=0 from public.tracker_accounts where id=:cash),'transfer delete reverses both legs');
select test.reject(format('insert into public.tracker_transfers(from_account,to_account,amount) values(%s,%s,1)',:bank,:bank),'23514','same-account transfer rejected');

insert into public.tracker_money_debts(direction,person_name,amount) values('BORROWED','Alice debt',100) returning id as debt \gset
insert into public.tracker_debt_payments(debt,amount) values(:debt,60) returning id as repayment \gset
select test.assert((select amount_paid=60 and status='PARTIAL' from public.tracker_money_debts where id=:debt),'debt repayment maintains amount and status');
select test.reject(format('insert into public.tracker_debt_payments(debt,amount) values(%s,41)',:debt),'23514','debt overpayment rejected');
select test.assert((select amount_paid=60 from public.tracker_money_debts where id=:debt) and (select count(*)=1 from public.tracker_debt_payments where debt=:debt),'debt overpayment fully rolls back');
update public.tracker_debt_payments set amount=100 where id=:repayment;
select test.assert((select amount_paid=100 and status='PAID' from public.tracker_money_debts where id=:debt),'repayment edit derives paid status');
select test.reject(format('update public.tracker_money_debts set amount=99 where id=%s',:debt),'23514','debt principal cannot fall below repaid total');
select test.reject(format('update public.tracker_money_debts set amount_paid=0 where id=%s',:debt),'42501','debt counter cannot be edited');
delete from public.tracker_debt_payments where id=:repayment;
select test.assert((select amount_paid=0 and status='PENDING' from public.tracker_money_debts where id=:debt),'repayment deletion reverses counter');

insert into public.tracker_credit_cards(name,outstanding,linked_account) values('Alice card',100,:bank) returning id as card \gset
insert into public.tracker_credit_card_activities(card,activity_type,amount) values(:card,'PURCHASE',50) returning id as purchase \gset
select test.assert((select outstanding=150 from public.tracker_credit_cards where id=:card),'purchase adds outstanding');
select id as payment from public.tracker_pay_card(:card,75,:bank,current_date,'Payment') \gset
select test.assert((select outstanding=75 from public.tracker_credit_cards where id=:card) and (select balance=925 from public.tracker_accounts where id=:bank),'card RPC atomically debits account and outstanding');
select test.reject(format('select public.tracker_pay_card(%s,76,%s,current_date,'''')',:card,:bank),'23514','card overpayment rejected');
select test.reject(format('select public.tracker_pay_card(%s,10,%s,current_date,'''')',:card,:bob_account),'23503','cross-owner card payment account rejected');
select test.assert((select outstanding=75 from public.tracker_credit_cards where id=:card) and (select balance=925 from public.tracker_accounts where id=:bank),'failed card payments roll back both balances');
select test.reject(format('update public.tracker_credit_cards set outstanding=0 where id=%s',:card),'42501','outstanding cannot be edited');
update public.tracker_credit_card_activities set amount=50 where id=:payment;
select test.assert((select outstanding=100 from public.tracker_credit_cards where id=:card) and (select balance=950 from public.tracker_accounts where id=:bank),'payment edit reverses previous amount');
delete from public.tracker_credit_card_activities where id=:payment;
delete from public.tracker_credit_card_activities where id=:purchase;
select test.assert((select outstanding=100 from public.tracker_credit_cards where id=:card) and (select balance=1000 from public.tracker_accounts where id=:bank),'card payment and purchase deletions reverse balances');
insert into public.tracker_credit_card_activities(card,activity_type,amount,adjustment_direction) values(:card,'ADJUSTMENT',20,-1) returning id as adjustment \gset
select test.assert((select outstanding=80 from public.tracker_credit_cards where id=:card),'explicit negative adjustment supported');
delete from public.tracker_credit_card_activities where id=:adjustment;

insert into public.tracker_recurring_rules(title,amount,account,frequency,next_run,end_date)
 values('Daily test',10,:bank,'DAILY',current_date-2,current_date) returning id as recurring \gset
select test.assert((public.tracker_process_recurring()->>'created_count')::int=3,'recurring catches up inclusive end date');
select test.assert((public.tracker_process_recurring()->>'created_count')::int=0,'recurring rerun is idempotent');
select test.assert((select balance=970 from public.tracker_accounts where id=:bank),'recurring expense balances applied exactly once');
select test.assert((select last_run=current_date and next_run=current_date+1 and not active from public.tracker_recurring_rules where id=:recurring),'recurring cursor and final state persisted');
select test.reject($q$update public.tracker_recurring_rules set last_run=current_date$q$,'42501','recurring last_run protected');

insert into public.tracker_bills(title,amount,due_date) values('Rent',100,current_date);
insert into public.tracker_savings_goals(name,target_amount,current_amount) values('Trip',100,10);
insert into public.tracker_category_budgets(category,amount) values('Food',200);
insert into public.tracker_categories(name) values('Custom');
insert into public.tracker_assistant_notes(content) values('Remember rent');
insert into public.tracker_notifications(title,message) values('Test','Private');
insert into public.tracker_debt_payments(debt,amount) values(:debt,1);
insert into public.tracker_transfers(from_account,to_account,amount) values(:bank,:cash,1);
insert into public.tracker_credit_card_activities(card,activity_type,amount) values(:card,'PURCHASE',1);

select test.assert((select count(*)=0 from storage.objects),'other user receipts hidden');
insert into storage.objects(bucket_id,name) values('tracker-receipts','11111111-1111-1111-1111-111111111111/alice.jpg');
select test.reject($q$insert into storage.objects(bucket_id,name) values('tracker-receipts','22222222-2222-2222-2222-222222222222/spoof.jpg')$q$,'42501','receipt folder spoof denied');
select test.reject($q$update storage.objects set name='22222222-2222-2222-2222-222222222222/moved.jpg'$q$,'42501','receipt cross-owner rename denied');
select test.assert((select count(*)=1 from storage.objects),'owner sees only own receipt');

do $$ declare t record; cols text; vals text; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' and tablename not in ('tracker_profiles','tracker_assistant_commands') loop
    select string_agg(quote_ident(column_name),',' order by column_name),
      string_agg(case when column_name='user_id' then '''22222222-2222-2222-2222-222222222222''::uuid' else quote_ident(column_name) end,',' order by column_name)
      into cols,vals from information_schema.column_privileges
      where table_schema='public' and table_name=t.tablename and grantee='authenticated' and privilege_type='INSERT';
    perform test.reject(format('insert into public.%I(%s) select %s from public.%I limit 1',t.tablename,cols,vals,t.tablename),'42501',t.tablename || ': spoofed insert owner rejected');
  end loop;
end $$;

-- Every table has four owner policies and no anonymous table privilege. Test each
-- table, rather than assuming the shared policy-generation block is sufficient.
reset role;
do $$ declare t record; n int; begin
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' loop
    select count(*) into n from pg_policies where schemaname='public' and tablename=t.tablename and cmd<>'ALL';
    perform test.assert(n=4,t.tablename || ': four explicit policies');
    perform test.assert(exists(select 1 from pg_policies where schemaname='public' and tablename=t.tablename and policyname='session_assurance' and permissive='RESTRICTIVE' and cmd='ALL'),t.tablename || ': restrictive MFA policy covers every operation');
    perform test.assert(not has_table_privilege('anon','public.'||t.tablename,'SELECT,INSERT,UPDATE,DELETE'),t.tablename || ': no anon privilege');
    if t.tablename <> 'tracker_profiles' then
      perform test.assert(not has_sequence_privilege('anon',pg_get_serial_sequence('public.'||t.tablename,'id'),'USAGE,SELECT,UPDATE'),t.tablename || ': no anon sequence privilege');
    end if;
  end loop;
end $$;
set role authenticated;
set request.jwt.claim.sub='22222222-2222-2222-2222-222222222222';
do $$ declare t record; n int; col text; begin
  -- RPC-only command write denial is tested separately in assistant.sql.
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'tracker\_%' escape '\' and tablename<>'tracker_assistant_commands' loop
    col := case when t.tablename='tracker_profiles' then 'id' else 'user_id' end;
    execute format('select count(*) from public.%I where %I=''11111111-1111-1111-1111-111111111111''',t.tablename,col) into n;
    perform test.assert(n=0,t.tablename || ': cross-owner read hidden');
    execute format('delete from public.%I where %I=''11111111-1111-1111-1111-111111111111''',t.tablename,col);
    get diagnostics n = row_count;
    perform test.assert(n=0,t.tablename || ': cross-owner delete hidden');
    select column_name into col from information_schema.column_privileges where table_schema='public' and table_name=t.tablename and grantee='authenticated' and privilege_type='UPDATE' order by column_name limit 1;
    execute format('update public.%I set %I=%I where %I=''11111111-1111-1111-1111-111111111111''',t.tablename,col,col,case when t.tablename='tracker_profiles' then 'id' else 'user_id' end);
    get diagnostics n = row_count;
    perform test.assert(n=0,t.tablename || ': cross-owner update hidden');
  end loop;
end $$;
set role anon;
select test.reject('select * from public.tracker_accounts','42501','anonymous table read denied');
select test.reject('select public.tracker_process_recurring()','42501','anonymous recurring RPC denied');
select test.reject('select public.tracker_pay_card(1,1,1,current_date,'''')','42501','anonymous card RPC denied');
set role authenticated;
set request.jwt.claim.sub='';
select test.assert((select count(*)=0 from public.tracker_accounts),'missing JWT cannot read accounts');
select test.reject('select public.tracker_process_recurring()','42501','recurring RPC requires auth UID');
select test.reject('select public.tracker_pay_card(1,1,1,current_date,'''')','42501','card RPC requires auth UID');
reset role;
