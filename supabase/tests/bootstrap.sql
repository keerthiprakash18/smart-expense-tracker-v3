-- Minimal Supabase-owned interfaces for an isolated, disposable PostgreSQL test
-- cluster. NEVER apply this file as a migration or against an existing database.
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users(id uuid primary key, raw_user_meta_data jsonb not null default '{}');
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as
  $$ select jsonb_build_object('sub',auth.uid(),'aal',coalesce(nullif(current_setting('request.jwt.claim.aal',true),''),'aal1')) $$;
create table auth.mfa_factors(id uuid primary key,user_id uuid not null references auth.users(id) on delete cascade,status text not null check(status in ('unverified','verified')));
grant usage on schema auth to anon,authenticated;
grant execute on function auth.uid() to anon,authenticated;
grant execute on function auth.jwt() to anon,authenticated;
create schema storage;
create table storage.buckets(id text primary key,name text not null,public boolean not null default false,
  file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id bigint generated always as identity primary key,bucket_id text references storage.buckets(id),name text not null);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as
  $$ select (string_to_array(name,'/'))[1:array_length(string_to_array(name,'/'),1)-1] $$;
grant usage on schema storage to authenticated,anon;
grant select,insert,update,delete on storage.objects to authenticated;
grant execute on function storage.foldername(text) to authenticated;

create schema test;
grant usage on schema test to authenticated,anon;
create function test.assert(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
-- Exercise the migration against permissive project defaults too; explicit
-- revocations must remove these rather than relying on stock PostgreSQL ACLs.
alter default privileges in schema public grant all on tables to anon,authenticated;
alter default privileges in schema public grant all on sequences to anon,authenticated;
create function test.reject(sql text,expected text,label text) returns void language plpgsql as $$
declare rejected boolean := false;
begin
  begin execute sql;
  exception when others then
    if sqlstate <> all(string_to_array(expected,',')) then raise exception 'FAIL: %: expected SQLSTATE %, got %: %',label,expected,sqlstate,sqlerrm; end if;
    rejected := true;
  end;
  perform test.assert(rejected,label);
end $$;
