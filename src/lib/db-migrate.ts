import pg from 'pg';

let twrDailyColumnReady: boolean | null = null;
let twrSeriesTableReady: boolean | null = null;

async function runSql(sql: string): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return false;

  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    await client.query(sql);
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/** Ajoute statements.twr_daily si absent. */
export async function ensureTwrDailyColumn(): Promise<boolean> {
  if (twrDailyColumnReady === true) return true;
  const ok = await runSql(
    `alter table public.statements add column if not exists twr_daily jsonb not null default '[]'::jsonb`,
  );
  if (ok) twrDailyColumnReady = true;
  return ok;
}

/** Crée twr_series (TWR journalier IBKR) si absent. */
export async function ensureTwrSeriesTable(): Promise<boolean> {
  if (twrSeriesTableReady === true) return true;
  const ok = await runSql(`
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
  `);
  if (ok) twrSeriesTableReady = true;
  return ok;
}

/** Colonne accounts.analysis_start_lock */
export async function ensureAnalysisStartLockColumn(): Promise<boolean> {
  return runSql(
    `alter table public.accounts add column if not exists analysis_start_lock date`,
  );
}
