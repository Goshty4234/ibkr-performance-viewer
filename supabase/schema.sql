-- IBKR Performance Viewer — Supabase schema
-- Run in Supabase SQL Editor or via /api/setup

-- User-managed portfolio accounts (linked to IBKR account IDs from CSV)
create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  ibkr_account_id text not null,
  display_name text not null,
  notes text not null default '',
  analysis_start_lock date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Statements imported from IBKR Activity CSV
create table if not exists public.statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_account_id uuid references public.accounts(id) on delete cascade,
  account_id text not null,
  account_alias text default '',
  base_currency text not null default 'USD',
  period_start date not null,
  period_end date not null,
  starting_nav numeric not null default 0,
  ending_nav numeric not null default 0,
  twrr numeric not null default 0,
  filename text not null,
  cash_flows jsonb not null default '[]'::jsonb,
  daily_events jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now()
);

-- User preferences (default benchmark, etc.)
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_benchmark text not null default 'SPY',
  updated_at timestamptz not null default now()
);

-- Row Level Security
alter table public.accounts enable row level security;
alter table public.statements enable row level security;
alter table public.user_settings enable row level security;

-- Accounts policies
drop policy if exists "Users can view own accounts" on public.accounts;
create policy "Users can view own accounts"
  on public.accounts for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own accounts" on public.accounts;
create policy "Users can insert own accounts"
  on public.accounts for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own accounts" on public.accounts;
create policy "Users can update own accounts"
  on public.accounts for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own accounts" on public.accounts;
create policy "Users can delete own accounts"
  on public.accounts for delete using (auth.uid() = user_id);

-- Statements policies
drop policy if exists "Users can view own statements" on public.statements;
create policy "Users can view own statements"
  on public.statements for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own statements" on public.statements;
create policy "Users can insert own statements"
  on public.statements for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own statements" on public.statements;
create policy "Users can update own statements"
  on public.statements for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own statements" on public.statements;
create policy "Users can delete own statements"
  on public.statements for delete using (auth.uid() = user_id);

-- Settings policies
drop policy if exists "Users can view own settings" on public.user_settings;
create policy "Users can view own settings"
  on public.user_settings for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own settings" on public.user_settings;
create policy "Users can insert own settings"
  on public.user_settings for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own settings" on public.user_settings;
create policy "Users can update own settings"
  on public.user_settings for update using (auth.uid() = user_id);

-- Indexes
create index if not exists accounts_user_id_idx on public.accounts(user_id);
create index if not exists statements_user_id_idx on public.statements(user_id);
create index if not exists statements_account_idx on public.statements(user_id, account_id);
create index if not exists statements_period_idx on public.statements(user_id, period_start, period_end);

-- Migration for existing databases
alter table public.statements add column if not exists daily_events jsonb not null default '[]'::jsonb;
alter table public.statements add column if not exists twr_daily jsonb not null default '[]'::jsonb;
alter table public.statements add column if not exists portfolio_account_id uuid references public.accounts(id) on delete cascade;

create index if not exists statements_portfolio_account_idx on public.statements(user_id, portfolio_account_id);

alter table public.accounts drop constraint if exists accounts_user_id_ibkr_account_id_key;

update public.statements s
set portfolio_account_id = a.id
from public.accounts a
where s.portfolio_account_id is null
  and s.user_id = a.user_id
  and s.account_id = a.ibkr_account_id;

alter table public.statements drop constraint if exists statements_user_id_account_id_period_start_period_end_key;

create unique index if not exists statements_user_portfolio_period_idx
  on public.statements (user_id, portfolio_account_id, period_start, period_end)
  where portfolio_account_id is not null;

-- Daily NAV from IBKR Flex Query (NAV in Base + Breakout by Day)
create table if not exists public.nav_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_account_id uuid not null references public.accounts(id) on delete cascade,
  account_id text not null,
  account_alias text default '',
  base_currency text not null default 'CAD',
  period_start date not null,
  period_end date not null,
  filename text not null,
  points jsonb not null default '[]'::jsonb,
  cash_flows jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now()
);

alter table public.nav_series enable row level security;

drop policy if exists "Users can view own nav_series" on public.nav_series;
create policy "Users can view own nav_series"
  on public.nav_series for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own nav_series" on public.nav_series;
create policy "Users can insert own nav_series"
  on public.nav_series for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own nav_series" on public.nav_series;
create policy "Users can update own nav_series"
  on public.nav_series for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own nav_series" on public.nav_series;
create policy "Users can delete own nav_series"
  on public.nav_series for delete using (auth.uid() = user_id);

create unique index if not exists nav_series_portfolio_idx
  on public.nav_series (user_id, portfolio_account_id);

create index if not exists nav_series_user_id_idx on public.nav_series(user_id);

alter table public.nav_series add column if not exists cash_flows jsonb not null default '[]'::jsonb;

-- Daily TWR from IBKR Performance Report (Time Period Benchmark Comparison)
create table if not exists public.twr_series (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_account_id uuid not null references public.accounts(id) on delete cascade,
  account_id text not null,
  account_alias text default '',
  base_currency text not null default 'CAD',
  period_start date not null,
  period_end date not null,
  twrr double precision not null default 0,
  filename text not null,
  points jsonb not null default '[]'::jsonb,
  imported_at timestamptz not null default now()
);

alter table public.twr_series enable row level security;

drop policy if exists "Users can view own twr_series" on public.twr_series;
create policy "Users can view own twr_series"
  on public.twr_series for select using (auth.uid() = user_id);

drop policy if exists "Users can insert own twr_series" on public.twr_series;
create policy "Users can insert own twr_series"
  on public.twr_series for insert with check (auth.uid() = user_id);

drop policy if exists "Users can update own twr_series" on public.twr_series;
create policy "Users can update own twr_series"
  on public.twr_series for update using (auth.uid() = user_id);

drop policy if exists "Users can delete own twr_series" on public.twr_series;
create policy "Users can delete own twr_series"
  on public.twr_series for delete using (auth.uid() = user_id);

create unique index if not exists twr_series_portfolio_idx
  on public.twr_series (user_id, portfolio_account_id);

create index if not exists twr_series_user_id_idx on public.twr_series(user_id);

alter table public.accounts add column if not exists analysis_start_lock date;
