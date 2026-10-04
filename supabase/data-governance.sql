-- Data governance (run once in the Supabase SQL editor; safe to re-run).
--
--  1. accounts.view_prefs: the view settings of each IBKR account (comparisons, hidden curves, period),
--     so they follow the person from one computer to the next.
--  2. Purges: "all" no longer deletes IBKR accounts or their data (long-term tracking). A separate,
--     explicit scope "ibkr" (one named user) clears their IBKR data and keeps the accounts.
--  3. The IBKR positions table (holdings_series) is counted in the usage figures.

alter table public.accounts add column if not exists view_prefs jsonb not null default '{}'::jsonb;

create or replace function public.admin_purge_files(p_scope text, p_user uuid default null, p_days int default null)
returns text[] language plpgsql stable security definer set search_path = '' as $$
declare names text[];
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('old', 'results', 'all', 'ibkr') then raise exception 'invalid scope'; end if;
  if p_scope = 'ibkr' then return '{}'::text[]; end if; -- IBKR data lives in database rows, not in stored files
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

create or replace function public.admin_purge_rows(p_scope text, p_user uuid default null, p_days int default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare runs_n int := 0; cfg_n int := 0; ibkr_n int := 0; n int := 0;
begin
  if not public.is_admin() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('old', 'results', 'all', 'ibkr') then raise exception 'invalid scope'; end if;

  -- IBKR tracking is long-term data: only this explicit scope touches it, for one named user.
  -- The accounts themselves (name, start lock, view settings) always stay.
  if p_scope = 'ibkr' then
    if p_user is null then raise exception 'user required'; end if;
    delete from public.statements where user_id = p_user;     get diagnostics n = row_count; ibkr_n := ibkr_n + n;
    delete from public.nav_series where user_id = p_user;     get diagnostics n = row_count; ibkr_n := ibkr_n + n;
    delete from public.twr_series where user_id = p_user;     get diagnostics n = row_count; ibkr_n := ibkr_n + n;
    delete from public.holdings_series where user_id = p_user; get diagnostics n = row_count; ibkr_n := ibkr_n + n;
    return jsonb_build_object('runs', 0, 'configs', 0, 'accounts', 0, 'ibkr', ibkr_n);
  end if;

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
    -- runs, saved configurations and drafts; NOT the IBKR accounts and their data
    delete from public.backtest_portfolios where (p_user is null or user_id = p_user);
    get diagnostics cfg_n = row_count;
    update public.user_settings
      set backtest_workspace = null, backtest_workspace_at = null, allocation_values = null
      where (p_user is null or user_id = p_user);
  end if;
  return jsonb_build_object('runs', runs_n, 'configs', cfg_n, 'accounts', 0, 'ibkr', 0);
end $$;

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
        union all select pg_column_size(t.*) from public.holdings_series t where t.user_id = auth.uid()
      ) x),
    'runs', (select count(*) from public.backtest_runs where user_id = auth.uid()),
    'configs', (select count(*) from public.backtest_portfolios where user_id = auth.uid())
  );
$$;

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
        union all select user_id, pg_column_size(t.*) from public.holdings_series t
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


notify pgrst, 'reload schema';
