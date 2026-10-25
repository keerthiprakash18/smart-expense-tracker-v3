begin;
-- Commands are execution/idempotency records, not portable finance rows. Retain
-- completed records on restore, and invalidate previews against replaced data.
alter function public.tracker_restore_backup(jsonb,boolean) set schema tracker_private;
revoke all on function tracker_private.tracker_restore_backup(jsonb,boolean) from public,anon,authenticated;
create function public.tracker_restore_backup(p_data jsonb,p_confirm boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if not tracker_private.session_allowed() then raise exception 'Authentication or MFA verification required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,7491));
  result := tracker_private.tracker_restore_backup(p_data,p_confirm);
  update public.tracker_assistant_commands set status='CANCELLED',response_text='Finance data was restored. Submit a new assistant command.'
    where user_id=auth.uid() and status in ('PENDING','NEEDS_CLARIFICATION');
  return result;
end $$;
revoke all on function public.tracker_restore_backup(jsonb,boolean) from public,anon;
grant execute on function public.tracker_restore_backup(jsonb,boolean) to authenticated;
commit;
