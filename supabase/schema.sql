-- IBKR Performance Viewer — Supabase schema
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql

-- Statements imported from IBKR Activity CSV
create table if not exists public.statements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
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
  imported_at timestamptz not null default now(),
  unique (user_id, account_id, period_start, period_end)
);

-- User preferences (default benchmark, etc.)
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_benchmark text not null default 'SPY',
  updated_at timestamptz not null default now()
);

-- Row Level Security
alter table public.statements enable row level security;
alter table public.user_settings enable row level security;

create policy "Users can view own statements"
  on public.statements for select
  using (auth.uid() = user_id);

create policy "Users can insert own statements"
  on public.statements for insert
  with check (auth.uid() = user_id);

create policy "Users can update own statements"
  on public.statements for update
  using (auth.uid() = user_id);

create policy "Users can delete own statements"
  on public.statements for delete
  using (auth.uid() = user_id);

create policy "Users can view own settings"
  on public.user_settings for select
  using (auth.uid() = user_id);

create policy "Users can insert own settings"
  on public.user_settings for insert
  with check (auth.uid() = user_id);

create policy "Users can update own settings"
  on public.user_settings for update
  using (auth.uid() = user_id);

-- Index for fast queries
create index if not exists statements_user_id_idx on public.statements(user_id);
create index if not exists statements_period_idx on public.statements(user_id, period_start, period_end);
