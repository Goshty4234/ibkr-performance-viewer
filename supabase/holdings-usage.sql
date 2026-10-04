-- Counts the IBKR positions table (holdings_series) in the usage figures. Safe to re-run; grants are kept.

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
