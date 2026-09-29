import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import type { PortfolioConfig } from '@/lib/engine/types';

/** Row of public.backtest_portfolios (config = Streamlit JSON for one portfolio). */
export interface SavedPortfolio {
  id: string;
  name: string;
  folder: string;
  config: PortfolioConfig;
  created_at: string;
  updated_at: string;
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

/** Saves configs; an existing row with the same name + folder is overwritten. */
export async function savePortfolios(configs: PortfolioConfig[], folder: string): Promise<number> {
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
  for (const c of configs) {
    const id = byName.get(c.name);
    if (id) {
      const { error } = await supabase.from('backtest_portfolios').update({ config: c, updated_at: now }).eq('id', id);
      if (error) throw new Error(error.message);
    } else {
      inserts.push({ user_id: user.id, name: c.name.slice(0, 200), folder: dir, config: c });
    }
  }
  if (inserts.length) {
    const { error } = await supabase.from('backtest_portfolios').insert(inserts);
    if (error) throw new Error(error.message);
  }
  return configs.length;
}

export async function updateSaved(id: string, patch: { name?: string; folder?: string }): Promise<void> {
  const supabase = createClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.folder !== undefined) row.folder = patch.folder.trim();
  if (patch.name !== undefined) {
    const { data, error } = await supabase.from('backtest_portfolios').select('config').eq('id', id).single();
    if (error) throw new Error(error.message);
    row.name = patch.name.slice(0, 200);
    row.config = { ...(data.config as PortfolioConfig), name: patch.name };
  }
  const { error } = await supabase.from('backtest_portfolios').update(row).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteSaved(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const supabase = createClient();
  const { error } = await supabase.from('backtest_portfolios').delete().in('id', ids);
  if (error) throw new Error(error.message);
}
