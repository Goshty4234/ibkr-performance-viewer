import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import type { PortfolioConfig, RunOptions } from '@/lib/engine/types';
import { mirrorConfigsSoon } from '@/lib/storage/mirror';

/** A whole run kept as one save: every portfolio plus the run settings (dates, start rule...). */
export interface SavedRun {
  kind: 'run';
  portfolios: PortfolioConfig[];
  options: Partial<RunOptions>;
}

/** Row of public.backtest_portfolios: config = one portfolio (Streamlit JSON) or a SavedRun. */
export interface SavedPortfolio {
  id: string;
  name: string;
  folder: string;
  config: PortfolioConfig | SavedRun;
  created_at: string;
  updated_at: string;
}

export function isSavedRun(config: SavedPortfolio['config']): config is SavedRun {
  return (config as SavedRun)?.kind === 'run' && Array.isArray((config as SavedRun).portfolios);
}

/** Run settings worth keeping: the per-launch ones (price mode, axis alignment) are not. */
export function savedRunOptions(options: Partial<RunOptions> | undefined): Partial<RunOptions> {
  const { align_start: _a, price_update: _p, ...rest } = options ?? {};
  return rest;
}

const COLUMNS = 'id,name,folder,config,created_at,updated_at';

export async function listSaved(): Promise<SavedPortfolio[]> {
  if (isGuest()) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from('backtest_portfolios')
    .select(COLUMNS)
    .order('folder', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as SavedPortfolio[];
}

/** Writes entries; an existing row with the same name + folder is overwritten. */
async function upsert(entries: { name: string; config: SavedPortfolio['config'] }[], folder: string): Promise<number> {
  if (isGuest()) throw new Error('Mode invité : crée un compte pour enregistrer tes portfolios.');
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Connecte-toi pour enregistrer tes portfolios.');
  const dir = folder.trim();
  const { data: existing, error: e1 } = await supabase
    .from('backtest_portfolios')
    .select('id,name')
    .eq('folder', dir);
  if (e1) throw new Error(e1.message);
  const byName = new Map((existing ?? []).map((r) => [r.name as string, r.id as string]));
  const now = new Date().toISOString();
  const inserts: Record<string, unknown>[] = [];
  for (const { name, config } of entries) {
    const id = byName.get(name);
    if (id) {
      const { error } = await supabase.from('backtest_portfolios').update({ config, updated_at: now }).eq('id', id);
      if (error) throw new Error(error.message);
    } else {
      inserts.push({ user_id: user.id, name: name.slice(0, 200), folder: dir, config });
    }
  }
  if (inserts.length) {
    const { error } = await supabase.from('backtest_portfolios').insert(inserts);
    if (error) throw new Error(error.message);
  }
  mirrorConfigsSoon();
  return entries.length;
}

/** One save per portfolio, each under its own name. */
export function savePortfolios(configs: PortfolioConfig[], folder: string): Promise<number> {
  return upsert(configs.map((c) => ({ name: c.name, config: c })), folder);
}

/** All portfolios of a run in a single save: loading it brings them all back together. */
export async function saveRun(name: string, folder: string, portfolios: PortfolioConfig[], options: Partial<RunOptions>): Promise<void> {
  if (!portfolios.length) throw new Error('Aucun portfolio à enregistrer.');
  const config: SavedRun = {
    kind: 'run',
    portfolios: portfolios.map(({ start_date_user: _s, end_date_user: _e, ...c }) => c as PortfolioConfig),
    options: savedRunOptions(options),
  };
  await upsert([{ name, config }], folder);
}

export async function updateSaved(id: string, patch: { name?: string; folder?: string }): Promise<void> {
  const supabase = createClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.folder !== undefined) row.folder = patch.folder.trim();
  if (patch.name !== undefined) {
    const { data, error } = await supabase.from('backtest_portfolios').select('config').eq('id', id).single();
    if (error) throw new Error(error.message);
    row.name = patch.name.slice(0, 200);
    const config = data.config as SavedPortfolio['config'];
    if (!isSavedRun(config)) row.config = { ...config, name: patch.name };
  }
  const { error } = await supabase.from('backtest_portfolios').update(row).eq('id', id);
  if (error) throw new Error(error.message);
  mirrorConfigsSoon();
}

export async function deleteSaved(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const supabase = createClient();
  const { error } = await supabase.from('backtest_portfolios').delete().in('id', ids);
  if (error) throw new Error(error.message);
  mirrorConfigsSoon();
}
