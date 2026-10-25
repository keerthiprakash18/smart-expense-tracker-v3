begin;
-- Supabase Storage owns these tables. Keep receipts private; API operations use RLS.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('tracker-receipts','tracker-receipts',false,10485760,array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy tracker_receipts_select on storage.objects for select to authenticated
  using (bucket_id='tracker-receipts' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy tracker_receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id='tracker-receipts' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy tracker_receipts_update on storage.objects for update to authenticated
  using (bucket_id='tracker-receipts' and (storage.foldername(name))[1]=(select auth.uid())::text)
  with check (bucket_id='tracker-receipts' and (storage.foldername(name))[1]=(select auth.uid())::text);
create policy tracker_receipts_delete on storage.objects for delete to authenticated
  using (bucket_id='tracker-receipts' and (storage.foldername(name))[1]=(select auth.uid())::text);
commit;
