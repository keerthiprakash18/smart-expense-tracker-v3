begin;

create function tracker_private.expense_snapshot(e public.tracker_expenses) returns jsonb
language sql immutable set search_path='' as $$
  select jsonb_build_object('account',e.account,'amount',e.amount,'title',e.title,'category',e.category,
    'transaction_type',e.transaction_type,'date',e.date)
$$;

create function public.tracker_assistant_confirm(p_command bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid := auth.uid(); c public.tracker_assistant_commands; e public.tracker_expenses;
  p jsonb; account_id bigint; amount_value public.tracker_money; note_id bigint; d date;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));
  select * into c from public.tracker_assistant_commands where user_id=u and id=p_command for update;
  if not found then raise exception 'Assistant command not found' using errcode='P0002'; end if;
  if c.status='COMPLETED' then return tracker_private.serialize_command(c); end if;
  if c.status<>'PENDING' then raise exception 'This command is not waiting for confirmation' using errcode='55000'; end if;
  p := c.safe_payload;
  -- The subtransaction rolls back all ledger writes on failure while allowing
  -- the command's FAILED outcome to be persisted for an unambiguous retry.
  begin
    if c.intent in ('CREATE_EXPENSE','CREATE_INCOME') then
      amount_value := (p->>'amount')::numeric;
      if amount_value is null or amount_value<=0 then raise exception 'A positive finite amount is required' using errcode='22023'; end if;
      account_id := (p->>'account')::bigint;
      if account_id is not null and not exists(select 1 from public.tracker_accounts where user_id=u and id=account_id) then
        raise exception 'Selected account no longer belongs to you; submit a new command' using errcode='22023'; end if;
      d := coalesce((p->>'date')::date,current_date);
      insert into public.tracker_expenses(user_id,account,title,amount,transaction_type,category,payment_method,date,notes)
        values(u,account_id,coalesce(nullif(p->>'title',''),'Transaction'),amount_value,
          case when c.intent='CREATE_INCOME' then 'INCOME' else 'EXPENSE' end,
          coalesce(nullif(p->>'category',''),case when c.intent='CREATE_INCOME' then 'Salary' else 'General' end),
          'Other',d,'Added via in-app assistant') returning * into e;
      c."transaction" := e.id;
      c.result_payload := jsonb_build_object('transaction_id',e.id,'title',e.title,'amount',e.amount,'category',e.category,'transaction_type',e.transaction_type);
      c.response_text := 'Done. ' || tracker_private.assistant_money(u,e.amount) || ' added under ' || e.category || '.';
    elsif c.intent='CREATE_NOTE' then
      if length(trim(coalesce(p->>'note_content','')))=0 or length(p->>'note_content')>2000 then
        raise exception 'Note content must be 1 to 2000 characters' using errcode='22023'; end if;
      insert into public.tracker_assistant_notes(user_id,content,source) values(u,p->>'note_content',p->>'source') returning id into note_id;
      c.result_payload := jsonb_build_object('note_id',note_id,'note',p->>'note_content');
      c.response_text := 'Done. I saved that to your notes.';
    elsif c.intent in ('UPDATE_TRANSACTION','DELETE_TRANSACTION') then
      select * into e from public.tracker_expenses where user_id=u and id=(p->>'target_transaction_id')::bigint for update;
      if not found then raise exception 'That transaction no longer exists; submit a new command' using errcode='22023'; end if;
      if tracker_private.expense_snapshot(e) is distinct from p->'target_snapshot' then
        raise exception 'That transaction changed after the preview; submit a new command' using errcode='22023'; end if;
      if c.intent='UPDATE_TRANSACTION' then
        amount_value := (p->>'corrected_amount')::numeric;
        if amount_value is null or amount_value<=0 then raise exception 'A positive corrected amount is required' using errcode='22023'; end if;
        update public.tracker_expenses set amount=amount_value where user_id=u and id=e.id returning * into e;
        c."transaction" := e.id;
        c.result_payload := jsonb_build_object('transaction_id',e.id,'amount',e.amount);
        c.response_text := 'Done. ' || e.title || ' is now ' || tracker_private.assistant_money(u,e.amount) || '.';
      else
        c.result_payload := jsonb_build_object('deleted',jsonb_build_object('id',e.id,'title',e.title,'amount',e.amount,'category',e.category));
        delete from public.tracker_expenses where user_id=u and id=e.id;
        c."transaction" := null;
        c.response_text := 'Done. ' || e.title || ' was deleted.';
      end if;
    else raise exception 'Unsupported assistant mutation' using errcode='22023';
    end if;
    c.status := 'COMPLETED'; c.executed_at := statement_timestamp();
  exception when others then
    c.status := 'FAILED'; c.executed_at := null;
    c.result_payload := jsonb_build_object('error_code',sqlstate);
    c.response_text := case when sqlstate='22023' then sqlerrm else 'I could not complete that action safely. No financial change was made.' end;
  end;
  update public.tracker_assistant_commands set status=c.status,"transaction"=c."transaction",result_payload=c.result_payload,
    response_text=c.response_text,executed_at=c.executed_at where user_id=u and id=c.id returning * into c;
  return tracker_private.serialize_command(c);
end $$;

create function public.tracker_assistant_prepare(p_request_id uuid,p_intent text,p_payload jsonb,
  p_confidence numeric default 0,p_source text default 'TEXT',p_supersedes bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid := auth.uid(); c public.tracker_assistant_commands; prior public.tracker_assistant_commands;
  p jsonb := p_payload; a public.tracker_assistant_profiles; e public.tracker_expenses;
  k text; money_value public.tracker_money; account_id bigint; candidates bigint[]; target_id bigint;
  command_status text := 'PENDING'; message text := ''; result jsonb := '{}'; requires boolean := true;
  read_result jsonb; command_fingerprint text; duplicate boolean := false; quick boolean := false;
  response jsonb; start_date date; end_date date;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  if p_request_id is null then raise exception 'client_request_id is required' using errcode='22023'; end if;
  if p_source not in ('TEXT','VOICE_APP') or p_source is null then raise exception 'Only in-app TEXT and VOICE_APP are supported; background wake is unavailable' using errcode='0A000'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));
  select * into c from public.tracker_assistant_commands where user_id=u and client_request_id=p_request_id;
  if found then return jsonb_build_object('command',tracker_private.serialize_command(c),'created',false); end if;
  if p_intent is null or p_intent not in ('CREATE_NOTE','CREATE_EXPENSE','CREATE_INCOME','UPDATE_TRANSACTION','DELETE_TRANSACTION',
    'GET_DAILY_SPENDING','GET_WEEKLY_SPENDING','GET_MONTHLY_SPENDING','GET_CATEGORY_SPENDING','GET_SPENDING_SUMMARY',
    'GET_BUDGET','GET_BUDGET_STATUS','GET_BALANCE','GET_FINANCIAL_SUMMARY','COMPARE_SPENDING') then
    raise exception 'Unsupported assistant intent' using errcode='22023'; end if;
  if p_confidence is null or not p_confidence between 0 and 1 then raise exception 'Invalid confidence' using errcode='22023'; end if;
  perform tracker_private.validate_keys(p,array['amount','corrected_amount','category','title','transaction_type','date',
    'period_start','period_end','period_label','language','note_content','account','target_transaction_id','merchant','filter_date','use_recent']);
  if octet_length(p::text)>8192 then raise exception 'Assistant payload too large' using errcode='22023'; end if;
  foreach k in array array['amount','corrected_amount'] loop
    if p->>k is not null then
      money_value := (p->>k)::numeric;
      if money_value<=0 then raise exception 'Amounts must be positive and finite' using errcode='22023'; end if;
      p := jsonb_set(p,array[k],to_jsonb(money_value::text));
    end if;
  end loop;
  if length(coalesce(p->>'title',''))>200 or length(coalesce(p->>'category',''))>100
    or length(coalesce(p->>'merchant',''))>200 or length(coalesce(p->>'period_label',''))>40
    or length(coalesce(p->>'note_content',''))>2000 then raise exception 'Assistant text field is too long' using errcode='22023'; end if;
  if coalesce(p->>'language','EN') not in ('EN','TA','MIXED') then raise exception 'Invalid assistant language' using errcode='22023'; end if;
  if p->>'date' is not null and not isfinite((p->>'date')::date) then raise exception 'Invalid date' using errcode='22023'; end if;
  start_date := coalesce((p->>'period_start')::date,date_trunc('month',current_date)::date);
  end_date := coalesce((p->>'period_end')::date,current_date);
  if not isfinite(start_date) or not isfinite(end_date) or start_date>end_date then raise exception 'Invalid date range' using errcode='22023'; end if;
  p := p || jsonb_build_object('source',p_source);
  insert into public.tracker_assistant_profiles(user_id) values(u) on conflict(user_id) do nothing;
  select * into a from public.tracker_assistant_profiles where user_id=u;
  if p_supersedes is not null then
    select * into prior from public.tracker_assistant_commands where user_id=u and id=p_supersedes
      and status in ('PENDING','NEEDS_CLARIFICATION') and intent in ('CREATE_EXPENSE','CREATE_INCOME')
      and created_at>=statement_timestamp()-interval '10 minutes';
    if not found then raise exception 'The previous command is no longer available for clarification' using errcode='55000'; end if;
    if p_intent<>prior.intent then raise exception 'Clarification must keep the original transaction type' using errcode='22023'; end if;
  end if;

  if p_intent in ('CREATE_EXPENSE','CREATE_INCOME') then
    if p->>'account' is null then select id into account_id from public.tracker_accounts where user_id=u order by id limit 1;
    else account_id := (p->>'account')::bigint;
      if not exists(select 1 from public.tracker_accounts where user_id=u and id=account_id) then raise exception 'Account must belong to you' using errcode='42501'; end if;
    end if;
    p := p || jsonb_build_object('account',account_id,'transaction_type',case when p_intent='CREATE_INCOME' then 'INCOME' else 'EXPENSE' end,
      'date',coalesce((p->>'date')::date,current_date));
    if p->>'amount' is null then
      command_status := 'NEEDS_CLARIFICATION'; requires := false; message := 'I understood the transaction, but I need the amount.';
    elsif p_intent='CREATE_EXPENSE' and length(trim(coalesce(p->>'category','')))=0 then
      command_status := 'NEEDS_CLARIFICATION'; requires := false; message := 'Tell me the category, for example Food, Transport or Shopping.';
    else
      if p_intent='CREATE_INCOME' and length(trim(coalesce(p->>'category','')))=0 then p := p || '{"category":"Salary"}'; end if;
      message := tracker_private.assistant_money(u,(p->>'amount')::numeric) || ' ' || coalesce(p->>'title',p->>'category','Transaction')
        || ' · ' || coalesce(p->>'category','General') || '. Confirm to add this ' || case when p_intent='CREATE_INCOME' then 'income.' else 'expense.' end;
    end if;
  elsif p_intent in ('UPDATE_TRANSACTION','DELETE_TRANSACTION') then
    target_id := (p->>'target_transaction_id')::bigint;
    if target_id is null and coalesce((p->>'use_recent')::boolean,false) then
      select "transaction" into target_id from public.tracker_assistant_commands where user_id=u and status='COMPLETED'
        and "transaction" is not null and created_at>=statement_timestamp()-interval '10 minutes' order by created_at desc,id desc limit 1;
    end if;
    if target_id is null then
      select array_agg(id) into candidates from (select id from public.tracker_expenses tx where user_id=u
        and (nullif(p->>'category','') is null or lower(tx.category)=lower(p->>'category'))
        and (nullif(p->>'merchant','') is null or strpos(lower(tx.title),lower(p->>'merchant'))>0)
        and (not coalesce((p->>'filter_date')::boolean,false) or tx.date between start_date and end_date)
        order by date desc,id desc limit 2) q;
      if cardinality(candidates)=1 then target_id := candidates[1]; end if;
    end if;
    select * into e from public.tracker_expenses where user_id=u and id=target_id;
    if not found then
      command_status := 'NEEDS_CLARIFICATION'; requires := false;
      message := 'I could not identify one owned transaction. Specify its title/category/date or open Transactions.';
    elsif p_intent='UPDATE_TRANSACTION' and p->>'corrected_amount' is null then
      command_status := 'NEEDS_CLARIFICATION'; requires := false; message := 'Tell me the corrected amount.';
    else
      p := p || jsonb_build_object('target_transaction_id',e.id,'target_snapshot',tracker_private.expense_snapshot(e),'title',e.title,
        'category',e.category,'transaction_type',e.transaction_type,'date',e.date,
        'amount',case when p_intent='UPDATE_TRANSACTION' then p->>'corrected_amount' else e.amount::text end);
      message := case when p_intent='DELETE_TRANSACTION' then 'Delete ' || e.title || '? Please confirm.'
        else 'Update ' || e.title || ' to ' || tracker_private.assistant_money(u,(p->>'corrected_amount')::numeric) || '? Please confirm.' end;
    end if;
  elsif p_intent='CREATE_NOTE' then
    if length(trim(coalesce(p->>'note_content','')))=0 then raise exception 'Tell me what to note' using errcode='22023'; end if;
    requires := false;
  else
    read_result := tracker_private.assistant_query(u,p_intent,p);
    result := read_result->'result'; message := read_result->>'message'; command_status := 'COMPLETED'; requires := false;
  end if;
  command_fingerprint := md5(jsonb_build_object('intent',p_intent,'amount',p->'amount','category',p->'category','title',p->'title','date',p->'date','account',p->'account')::text);
  if p_intent in ('CREATE_EXPENSE','CREATE_INCOME') and command_status='PENDING' then
    select exists(select 1 from public.tracker_assistant_commands where user_id=u and status='COMPLETED'
      and fingerprint=command_fingerprint and created_at>=statement_timestamp()-interval '2 minutes') into duplicate;
    if duplicate then message := message || ' A very similar transaction was added recently.'; end if;
    quick := a.quick_add and a.confirmation_mode='SMART' and p_confidence>=0.92 and (p->>'amount')::numeric<=1000 and not duplicate;
    if quick then requires := false; end if;
  end if;
  if p_supersedes is not null then
    update public.tracker_assistant_commands set status='CANCELLED',response_text='Superseded by your latest assistant instruction.' where user_id=u and id=p_supersedes;
  end if;
  insert into public.tracker_assistant_commands(user_id,client_request_id,intent,safe_payload,result_payload,confidence,status,
    requires_confirmation,response_text,fingerprint)
    values(u,p_request_id,p_intent,p,result,p_confidence,command_status,requires,message,command_fingerprint) returning * into c;
  if quick or p_intent='CREATE_NOTE' then response := public.tracker_assistant_confirm(c.id);
  else response := tracker_private.serialize_command(c); end if;
  return jsonb_build_object('command',response,'created',true);
end $$;

create function public.tracker_assistant_cancel(p_command bigint) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u uuid := auth.uid(); c public.tracker_assistant_commands;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,7491));
  select * into c from public.tracker_assistant_commands where user_id=u and id=p_command for update;
  if not found then raise exception 'Assistant command not found' using errcode='P0002'; end if;
  if c.status='COMPLETED' then raise exception 'A completed action cannot be cancelled' using errcode='55000'; end if;
  if c.status<>'CANCELLED' then
    update public.tracker_assistant_commands set status='CANCELLED',response_text='Cancelled. No financial change was made.' where user_id=u and id=p_command returning * into c;
  end if;
  return tracker_private.serialize_command(c);
end $$;

revoke all on function tracker_private.expense_snapshot(public.tracker_expenses) from public,anon,authenticated;
revoke all on function public.tracker_assistant_prepare(uuid,text,jsonb,numeric,text,bigint),
  public.tracker_assistant_confirm(bigint),public.tracker_assistant_cancel(bigint) from public,anon;
grant execute on function public.tracker_assistant_prepare(uuid,text,jsonb,numeric,text,bigint),
  public.tracker_assistant_confirm(bigint),public.tracker_assistant_cancel(bigint) to authenticated;
commit;
