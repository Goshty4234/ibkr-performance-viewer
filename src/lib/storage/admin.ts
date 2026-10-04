import { createClient } from '@/lib/supabase/client';
import { RESULTS_BUCKET } from '@/lib/backtest/history';

/** Calls of the administrator page (database functions of supabase/storage_admin.sql). */

export interface AdminUser {
  id: string;
  email: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  tier: 'lean' | 'full';
  /** Explicit tier of the account, null = follows the default. */
  own_tier: 'lean' | 'full' | null;
  /** Online results quota in bytes, null = unlimited. */
  quota: number | null;
  is_admin: boolean;
  runs: number;
  pinned: number;
  configs: number;
  accounts: number;
  db_bytes: number;
  storage_bytes: number;
  files: number;
}

export interface AdminOverview {
  db_bytes: number;
  db_limit: number;
  storage_bytes: number;
  storage_limit: number;
  default_tier: 'lean' | 'full';
  lean_quota_bytes: number;
  user_count: number;
  users: AdminUser[];
}

/** The database answers "function not found" until storage_admin.sql has been run. */
export class MigrationMissing extends Error {}

function wrap(error: { message: string; code?: string }): Error {
  return /could not find the function|does not exist|schema cache/i.test(error.message) || error.code === 'PGRST202'
    ? new MigrationMissing('Les fonctions d’administration ne sont pas encore installées dans Supabase (fichier supabase/storage_admin.sql).')
    : new Error(error.message);
}

export async function adminOverview(limit = 500): Promise<AdminOverview> {
  const { data, error } = await createClient().rpc('admin_overview', { p_limit: limit });
  if (error) throw wrap(error);
  const o = data as AdminOverview;
  return {
    ...o,
    db_bytes: Number(o.db_bytes),
    db_limit: Number(o.db_limit),
    storage_bytes: Number(o.storage_bytes),
    storage_limit: Number(o.storage_limit),
    lean_quota_bytes: Number(o.lean_quota_bytes),
    users: (o.users ?? []).map((u) => ({
      ...u,
      quota: u.quota === null || u.quota === undefined ? null : Number(u.quota),
      db_bytes: Number(u.db_bytes),
      storage_bytes: Number(u.storage_bytes),
    })),
  };
}

export async function adminSetUserTier(userId: string, tier: 'lean' | 'full', quotaBytes: number | null): Promise<void> {
  const { error } = await createClient().rpc('admin_set_user_tier', { p_user: userId, p_tier: tier, p_quota: quotaBytes });
  if (error) throw wrap(error);
}

export async function adminSetConfig(key: 'default_tier' | 'lean_quota_bytes' | 'db_limit_bytes' | 'storage_limit_bytes', value: string | number): Promise<void> {
  const { error } = await createClient().rpc('admin_set_config', { p_key: key, p_value: value });
  if (error) throw wrap(error);
}

export type PurgeScope = 'old' | 'results' | 'all' | 'ibkr';

export interface PurgeReport {
  files: number;
  runs: number;
  configs: number;
  /** Database rows of IBKR tracking removed (only by the explicit "ibkr" scope). */
  ibkr: number;
}

/**
 * Purge of the online data. Files first (through the Storage API, which really frees the space),
 * then the rows; if a file batch fails nothing else is deleted. Local folders are never touched.
 *   old      unprotected runs older than `days`
 *   results  the whole run history: rows and result files (saved configurations, IBKR data and settings stay)
 *   all      results + saved configurations + drafts. IBKR accounts and their data are NEVER part of it:
 *            they are long-term tracking.
 *   ibkr     only IBKR tracking data (statements, NAV, TWR, positions) of ONE named user; the accounts stay
 */
export async function adminPurge(
  scope: PurgeScope,
  opts: { userId?: string | null; days?: number | null; onProgress?: (done: number, total: number) => void } = {},
): Promise<PurgeReport> {
  const supabase = createClient();
  const args = { p_scope: scope, p_user: opts.userId ?? null, p_days: opts.days ?? null };
  const { data: names, error } = await supabase.rpc('admin_purge_files', args);
  if (error) throw wrap(error);
  const files = (names ?? []) as string[];
  const bucket = supabase.storage.from(RESULTS_BUCKET);
  for (let k = 0; k < files.length; k += 400) {
    const { error: rmErr } = await bucket.remove(files.slice(k, k + 400));
    if (rmErr) throw new Error(`Suppression des fichiers interrompue : ${rmErr.message}`);
    opts.onProgress?.(Math.min(k + 400, files.length), files.length);
  }
  const { data: rows, error: rowsErr } = await supabase.rpc('admin_purge_rows', args);
  if (rowsErr) throw wrap(rowsErr);
  const r = (rows ?? {}) as { runs?: number; configs?: number; ibkr?: number };
  return { files: files.length, runs: r.runs ?? 0, configs: r.configs ?? 0, ibkr: r.ibkr ?? 0 };
}
