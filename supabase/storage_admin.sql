-- Storage tiers, quotas and admin tools (applied on top of schema.sql; safe to re-run).
--
--   tier 'lean'  : the account keeps only light results online (quota enforced by the storage policy)
--   tier 'full'  : everything is kept online (no quota unless the admin sets one)
--   admins       : always 'full'; the only ones who can read other users' usage and purge
--
-- Everything below is additive: it never touches existing rows.

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table public.app_admins enable row level security;
-- no policy on purpose: only the SECURITY DEFINER functions below read it

insert into public.app_admins (user_id)
select id from auth.users where lower(email) = 'voilanicolas@gmail.com'
on conflict do nothing;

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;

insert into public.app_config (key, value) values
  ('default_tier', '"lean"'),
  ('lean_quota_bytes', '25000000'),
  ('db_limit_bytes', '524288000'),
  ('storage_limit_bytes', '1073741824')
on conflict (key) do nothing;

create table if not exists public.user_storage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tier text not null default 'lean' check (tier in ('lean', 'full')),
  quota_bytes bigint,
  updated_at timestamptz not null default now()
);
alter table public.user_storage enable row level security;
drop policy if exists "Users can view own storage tier" on public.user_storage;
create policy "Users can view own storage tier"
  on public.user_storage for select using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER, fixed search_path)
-- ---------------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid());
$$;

create or replace function public.cfg_text(p_key text, p_default text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select value #>> '{}' from public.app_config where key = p_key), p_default);
$$;

create or replace function public.effective_tier(p_user uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.app_admins where user_id = p_user) then 'full'
    else coalesce((select tier from public.user_storage where user_id = p_user),
                  public.cfg_text('default_tier', 'lean'))
  end;
$$;

-- null = unlimited
create or replace function public.effective_quota(p_user uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.app_admins where user_id = p_user) then null
    else coalesce(
      (select quota_bytes from public.user_storage where user_id = p_user),
      case when public.effective_tier(p_user) = 'full' then null
           else public.cfg_text('lean_quota_bytes', '25000000')::bigint end)
  end;
$$;

create or replace function public.used_result_bytes(p_user uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select coalesce(sum((metadata ->> 'size')::bigint), 0)::bigint
  from storage.objects
  where bucket_id = 'backtest-results' and (storage.foldername(name))[1] = p_user::text;
$$;

create or replace function public.storage_has_room()
returns boolean language sql stable security definer set search_path = '' as $$
  select public.effective_quota(auth.uid()) is null
      or public.used_result_bytes(auth.uid()) < public.effective_quota(auth.uid());
$$;

-- What the signed-in user sees about their own account
create or replace function public.my_storage_profile()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'is_admin', public.is_admin(),
    'tier', public.effective_tier(auth.uid()),
    'quota_bytes', public.effective_quota(auth.uid()),
    'used_bytes', public.used_result_bytes(auth.uid()),
    'db_bytes', (
      select coalesce(sum(b), 0) from (
        select pg_column_size(t.*) b from public.backtest_runs t where t.user_id = auth.uid()
        union all select pg_column_size(t.*) from public.backtest_portfolios t where t.user_id = auth.uid()
        union all select pg_column_size(t.*) from public.statements t where t.user_id = auth.uid()
        union all select pg_column_size(t.*) from public.nav_series t where t.user_id = auth.uid()
        union all select pg_column_size(t.*) from public.twr_series t where t.user_id = auth.uid()
        union all select pg_column_size(t.*) from public.accounts t where t.user_id = auth.uid()
        union all select pg_column_size(t.*) from public.user_settings t where t.user_id = auth.uid()
      ) x),
    'runs', (select count(*) from public.backtest_runs where user_id = auth.uid()),
    'configs', (select count(*) from public.backtest_portfolios where user_id = auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Storage policies: server-side quota + admin access
-- ---------------------------------------------------------------------------

drop policy if exists "Users can upload own backtest results" on storage.objects;
create policy "Users can upload own backtest results"
  on storage.objects for insert
  with check (
    bucket_id = 'backtest-results'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.storage_has_room()
  );

drop policy if exists "Admins can read all backtest results" on storage.objects;
create policy "Admins can read all backtest results"
  on storage.objects for select to authenticated
  using (bucket_id = 'backtest-results' and public.is_admin());

drop policy if exists "Admins can delete all backtest results" on storage.objects;
create policy "Admins can delete all backtest results"
  on storage.objects for delete to authenticated
  using (bucket_id = 'backtest-results' and public.is_admin());

-- ---------------------------------------------------------------------------
-- Admin API
-- ---------------------------------------------------------------------------

create or replace function public.admin_overview(p_limit int default 500)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare res jsonb;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  with
    runs as (
      select user_id, count(*) n, count(*) filter (where pinned) pinned
      from public.backtest_runs group by user_id),
    cfgs as (select user_id, count(*) n from public.backtest_portfolios group by user_id),
    accts as (select user_id, count(*) n from public.accounts group by user_id),
    rowbytes as (
      select user_id, sum(b)::bigint bytes from (
        select user_id, pg_column_size(t.*) b from public.backtest_runs t
        union all select user_id, pg_column_size(t.*) from public.backtest_portfolios t
        union all select user_id, pg_column_size(t.*) from public.statements t
        union all select user_id, pg_column_size(t.*) from public.nav_series t
        union all select user_id, pg_column_size(t.*) from public.twr_series t
        union all select user_id, pg_column_size(t.*) from public.accounts t
        union all select user_id, pg_column_size(t.*) from public.user_settings t
      ) x group by user_id),
    files as (
      select (storage.foldername(name))[1] uid, sum((metadata ->> 'size')::bigint)::bigint bytes, count(*) n
      from storage.objects where bucket_id = 'backtest-results' group by 1),
    u as (
      select au.id, au.email, au.created_at, au.last_sign_in_at,
             public.effective_tier(au.id) tier,
             public.effective_quota(au.id) quota,
             exists (select 1 from public.app_admins a where a.user_id = au.id) is_admin,
             (select s.tier from public.user_storage s where s.user_id = au.id) own_tier,
             coalesce(runs.n, 0) runs, coalesce(runs.pinned, 0) pinned,
             coalesce(cfgs.n, 0) configs, coalesce(accts.n, 0) accounts,
             coalesce(rowbytes.bytes, 0) db_bytes,
             coalesce(files.bytes, 0) storage_bytes, coalesce(files.n, 0) files
      from auth.users au
      left join runs on runs.user_id = au.id
      left join cfgs on cfgs.user_id = au.id
      left join accts on accts.user_id = au.id
      left join rowbytes on rowbytes.user_id = au.id
      left join files on files.uid = au.id::text
      order by coalesce(files.bytes, 0) + coalesce(rowbytes.bytes, 0) desc
      limit greatest(p_limit, 1))
  select jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'db_limit', public.cfg_text('db_limit_bytes', '524288000')::bigint,
    'storage_bytes', (select coalesce(sum((metadata ->> 'size')::bigint), 0) from storage.objects where bucket_id = 'backtest-results'),
    'storage_limit', public.cfg_text('storage_limit_bytes', '1073741824')::bigint,
    'default_tier', public.cfg_text('default_tier', 'lean'),
    'lean_quota_bytes', public.cfg_text('lean_quota_bytes', '25000000')::bigint,
    'user_count', (select count(*) from auth.users),
    'users', coalesce((select jsonb_agg(to_jsonb(u)) from u), '[]'::jsonb)
  ) into res;
  return res;
end $$;

create or replace function public.admin_set_user_tier(p_user uuid, p_tier text, p_quota bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_tier not in ('lean', 'full') then raise exception 'invalid tier'; end if;
  insert into public.user_storage (user_id, tier, quota_bytes, updated_at)
  values (p_user, p_tier, p_quota, now())
  on conflict (user_id) do update set tier = excluded.tier, quota_bytes = excluded.quota_bytes, updated_at = now();
end $$;

create or replace function public.admin_set_config(p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key not in ('default_tier', 'lean_quota_bytes', 'db_limit_bytes', 'storage_limit_bytes') then
    raise exception 'unknown key';
  end if;
  if p_key = 'default_tier' and p_value not in ('"lean"'::jsonb, '"full"'::jsonb) then
    raise exception 'invalid tier';
  end if;
  insert into public.app_config (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- Step 1 of a purge: names of the stored files to remove (the client deletes them through the
-- Storage API, which also frees the underlying objects; SQL deletes would only drop the metadata).
--   scope: 'old'      unpinned runs older than p_days
--          'results'  every run result (pinned included)
--          'all'      every run result + saved configurations + IBKR data
-- p_user null = every user.
create or replace function public.admin_purge_files(p_scope text, p_user uuid default null, p_days int default null)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare names text[];
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('old', 'results', 'all') then raise exception 'invalid scope'; end if;
  if p_scope = 'old' then
    if p_days is null or p_days < 0 then raise exception 'days required'; end if;
    select coalesce(array_agg(distinct o.name), '{}') into names
    from storage.objects o
    join public.backtest_runs r
      on (o.name like r.user_id::text || '/' || r.id::text || '/%' or o.name = r.user_id::text || '/' || r.id::text || '.json.gz')
    where o.bucket_id = 'backtest-results'
      and r.pinned = false
      and r.created_at < now() - make_interval(days => p_days)
      and (p_user is null or r.user_id = p_user);
  else
    select coalesce(array_agg(o.name), '{}') into names
    from storage.objects o
    where o.bucket_id = 'backtest-results'
      and (p_user is null or (storage.foldername(o.name))[1] = p_user::text);
  end if;
  return names;
end $$;

-- Step 2: delete the rows. Never touches auth users or their tier settings.
create or replace function public.admin_purge_rows(p_scope text, p_user uuid default null, p_days int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare runs_n int := 0; cfg_n int := 0; acc_n int := 0;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('old', 'results', 'all') then raise exception 'invalid scope'; end if;
  if p_scope = 'old' then
    if p_days is null or p_days < 0 then raise exception 'days required'; end if;
    delete from public.backtest_runs
    where pinned = false and created_at < now() - make_interval(days => p_days)
      and (p_user is null or user_id = p_user);
  else
    delete from public.backtest_runs where (p_user is null or user_id = p_user);
  end if;
  get diagnostics runs_n = row_count;
  if p_scope = 'all' then
    delete from public.backtest_portfolios where (p_user is null or user_id = p_user);
    get diagnostics cfg_n = row_count;
    delete from public.accounts where (p_user is null or user_id = p_user); -- cascades statements, nav, twr
    get diagnostics acc_n = row_count;
    update public.user_settings
      set backtest_workspace = null, backtest_workspace_at = null, allocation_values = null
      where (p_user is null or user_id = p_user);
  end if;
  return jsonb_build_object('runs', runs_n, 'configs', cfg_n, 'accounts', acc_n);
end $$;

-- Internal helpers (effective_*, used_result_bytes, cfg_text) are NOT granted: callable only from the
-- definer functions above, so nobody can probe another user's usage.
revoke all on function public.is_admin() from public, anon;
-- Supabase grants new functions to anon/authenticated by default: helpers are revoked from both.
revoke all on function public.cfg_text(text, text) from public, anon, authenticated;
revoke all on function public.effective_tier(uuid) from public, anon, authenticated;
revoke all on function public.effective_quota(uuid) from public, anon, authenticated;
revoke all on function public.used_result_bytes(uuid) from public, anon, authenticated;
revoke all on function public.storage_has_room() from public, anon;
revoke all on function public.my_storage_profile() from public, anon;
revoke all on function public.admin_overview(int) from public, anon;
revoke all on function public.admin_set_user_tier(uuid, text, bigint) from public, anon;
revoke all on function public.admin_set_config(text, jsonb) from public, anon;
revoke all on function public.admin_purge_files(text, uuid, int) from public, anon;
revoke all on function public.admin_purge_rows(text, uuid, int) from public, anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.my_storage_profile() to authenticated;
grant execute on function public.storage_has_room() to authenticated;
grant execute on function public.admin_overview(int) to authenticated;
grant execute on function public.admin_set_user_tier(uuid, text, bigint) to authenticated;
grant execute on function public.admin_set_config(text, jsonb) to authenticated;
grant execute on function public.admin_purge_files(text, uuid, int) to authenticated;
grant execute on function public.admin_purge_rows(text, uuid, int) to authenticated;

notify pgrst, 'reload schema';
