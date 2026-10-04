import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import type { PortfolioConfig, PortfolioDetail, ResultSummary, RunOptions } from '@/lib/engine/types';
import {
  invalidateLocalList,
  localAvailable,
  localDeleteRun,
  localGetRunFile,
  localListRuns,
  localPatchMeta,
  localPutMeta,
  localPutRunFile,
  type LocalRun,
} from '@/lib/storage/local-library';
import { cloudFirst, getProfile, getResultSource, LEAN_DETAIL_MAX, LEAN_SUMMARY_MAX } from '@/lib/storage/profile';
import { bundleResult, type LoadedResult, toBundle } from './result-data';
import { packResult, readStoredJson } from './lean-codec';

export const RESULTS_BUCKET = 'backtest-results';
const UPLOAD_CONCURRENCY = 6;

/**
 * Where a run's data lives.
 *  - The local library (data folder of the engine on this PC) gets everything, always, when an
 *    engine runs here.
 *  - The database row (configuration + statistics list, a few KB) is always online: it is what
 *    lets any device list and restore a run.
 *  - The result files go online according to the account's tier: "full" = everything; "lean" =
 *    only what is light (summary <= LEAN_SUMMARY_MAX, chunks <= LEAN_DETAIL_MAX) and within the
 *    quota (also enforced by the storage policy of the database). A heavy run is then opened from
 *    the local library, or shows its summary and asks to be re-run.
 */

export interface RunSummaryRow {
  name: string;
  ok: boolean;
  /** Detail chunk index of this portfolio in the run. */
  index?: number;
  /** Engine history_key: identity of the result apart from its end date. */
  key?: string | null;
  cagr?: string;
  maxdd?: string;
  sharpe?: string;
  final?: number | null;
}

/**
 * result_path: "<uid>/<runId>/" (format 2: summary.json.gz + portfolio/<i>.json.gz)
 * or "<uid>/<runId>.json.gz" (format 1: one file); null when no result file is kept online.
 */
export interface BacktestRunRow {
  id: string;
  label: string;
  engine: string;
  engine_version: string;
  duration_s: number | null;
  simulation_start: string | null;
  simulation_end: string | null;
  summary: RunSummaryRow[];
  warnings: string[];
  result_path: string | null;
  result_size: number | null;
  pinned: boolean;
  created_at: string;
  kind?: RunKind;
  request_key?: string | null;
  engine_code?: string | null;
  config_keys?: string[];
  portfolio_keys?: string[];
  request?: { portfolios: PortfolioConfig[]; options: Partial<RunOptions> };
  /** True when some portfolio details were not stored online: re-run (or open from the local library). */
  details_partial?: boolean;
  /** Set when listing: the row exists online / a copy is in the local library / that copy is complete. */
  cloud?: boolean;
  local?: boolean;
  localFull?: boolean;
}

/** 'backtest' = launched from Construire; 'allocations' = today's target (short window). */
export type RunKind = 'backtest' | 'allocations';

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Result produced by the CLI / GitHub Actions / engine /result (.json.gz or .json, any format). */
export async function readResultFile(file: Blob, name: string): Promise<LoadedResult> {
  const bundle = toBundle(await readStoredJson(file));
  return bundleResult(`file:${name}:${file.size}`, bundle);
}

export function summarize(summary: ResultSummary): RunSummaryRow[] {
  return summary.portfolios.map((p) =>
    p.ok
      ? {
          name: p.name,
          ok: true,
          index: p.index,
          key: p.history_key ?? null,
          cagr: p.stats_display.CAGR,
          maxdd: p.stats_display.MaxDrawdown,
          sharpe: p.stats_display.Sharpe,
          final: p.stats['Final Value (with)'] ?? null,
        }
      : { name: p.name, ok: false },
  );
}

const okCount = (row: Pick<BacktestRunRow, 'summary'>): number => (row.summary ?? []).filter((s) => s.ok).length;

/** True when the local copy holds the summary and every detail chunk of the run. */
function isLocalFull(row: Pick<BacktestRunRow, 'summary'>, l: LocalRun | undefined): boolean {
  return !!l && l.summary && l.portfolios.length >= okCount(row);
}

async function currentUid(): Promise<string | null> {
  if (isGuest()) return null;
  return (await getProfile())?.userId ?? null;
}

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

/**
 * Stores the run: the local library (when an engine runs here) and the online copy according to
 * the account tier. The online summary goes up before the details so the run is usable as soon as
 * possible. Returns the run id.
 */
export async function saveRun(args: {
  label: string;
  engine: string;
  request: { portfolios: PortfolioConfig[]; options: Partial<RunOptions> };
  requestKey?: string | null;
  engineCode?: string | null;
  kind?: RunKind;
  /** Aligned with summary.portfolios. */
  configKeys?: string[];
  summary: ResultSummary;
  summaryText: string;
  detailText: (index: number) => Promise<string>;
}): Promise<string | null> {
  if (isGuest()) return null;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const profile = await getProfile(0);
  const full = !!profile && (profile.tier === 'full' || profile.isAdmin);
  const id = crypto.randomUUID();
  const folder = `${user.id}/${id}/`;
  const bucket = supabase.storage.from(RESULTS_BUCKET);
  const hasLocal = localAvailable();
  const s = args.summary;

  // Compress everything once; both copies use the same bytes.
  const { blob: summaryBlob } = await packResult(s);
  const indices = s.portfolios.filter((p) => p.ok).map((p) => p.index);
  const chunks = new Map<number, Blob>();
  const chunkErrors: string[] = [];
  await pool(indices, 4, async (i) => {
    try {
      chunks.set(i, (await packResult(JSON.parse(await args.detailText(i)))).blob);
    } catch (e) {
      chunkErrors.push(`${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // What goes online.
  let keepSummary = full || summaryBlob.size <= LEAN_SUMMARY_MAX;
  let cloudChunks = [...chunks.entries()].filter(([, b]) => full || b.size <= LEAN_DETAIL_MAX);
  const quota = profile?.quotaBytes ?? null;
  if (quota !== null && keepSummary) {
    const need = summaryBlob.size + cloudChunks.reduce((n, [, b]) => n + b.size, 0);
    if (!(await makeRoom(user.id, quota, need, profile?.usedBytes ?? 0))) {
      keepSummary = false;
      cloudChunks = [];
    }
  }

  // Local copy, in parallel with the online one.
  const localWrites: Promise<boolean>[] = [];
  if (hasLocal) {
    localWrites.push(localPutRunFile(user.id, id, 'summary.json.gz', summaryBlob));
    for (const [i, b] of chunks) localWrites.push(localPutRunFile(user.id, id, `portfolio/${i}.json.gz`, b));
  }

  // Online: summary, then the row, then the details.
  let size = 0;
  let cloudNote: string | null = null;
  if (keepSummary) {
    const up = await bucket.upload(`${folder}summary.json.gz`, summaryBlob, { contentType: 'application/gzip', upsert: true });
    if (up.error) {
      keepSummary = false;
      cloudChunks = [];
      cloudNote = `Stockage : ${up.error.message}`;
    } else {
      size = summaryBlob.size;
    }
  }
  const createdAt = new Date().toISOString();
  const rowData = {
    id,
    user_id: user.id,
    label: args.label.slice(0, 200),
    request: args.request,
    request_key: args.requestKey ?? null,
    engine_code: args.engineCode ?? null,
    kind: args.kind ?? 'backtest',
    config_keys: args.configKeys ?? [],
    portfolio_keys: s.portfolios.map((p) => (p.ok ? p.history_key ?? '' : '')),
    engine: args.engine,
    engine_version: s.engine_version,
    duration_s: s.duration_s,
    simulation_start: s.simulation.display_start ?? s.simulation.start,
    simulation_end: s.simulation.end,
    summary: summarize(s),
    warnings: s.warnings.slice(0, 50),
    result_path: keepSummary ? folder : null,
    result_size: size,
    details_partial: true,
  };
  const { error } = await supabase.from('backtest_runs').insert(rowData);
  if (error) {
    // Without a row nothing lists the run online; the local copy alone is still worth keeping.
    const ok = hasLocal && (await Promise.all(localWrites)).every(Boolean);
    if (!ok) throw new Error(error.message);
    await localPutMeta(user.id, { ...rowData, created_at: createdAt, pinned: false, result_path: null, result_size: 0, details_partial: false });
    return id;
  }

  const failures: string[] = [...chunkErrors];
  let uploaded = 0;
  if (keepSummary) {
    await pool(cloudChunks, UPLOAD_CONCURRENCY, async ([i, blob]) => {
      const r = await bucket.upload(`${folder}portfolio/${i}.json.gz`, blob, { contentType: 'application/gzip', upsert: true });
      if (r.error) failures.push(`${i}: ${r.error.message}`);
      else {
        size += blob.size;
        uploaded += 1;
      }
    });
  }
  const partial = !(keepSummary && uploaded === indices.length);
  await supabase.from('backtest_runs').update({ result_size: size, details_partial: partial }).eq('id', id);

  const localOk = hasLocal && (await Promise.all(localWrites)).every(Boolean) && chunkErrors.length === 0;
  if (hasLocal) {
    // The row travels with the files so the run stays listable if it disappears online.
    await localPutMeta(user.id, { ...rowData, created_at: createdAt, pinned: false, result_size: size, details_partial: partial });
  }
  invalidateLocalList();
  void getProfile(0); // usage changed

  // A lean run that is only partly online is expected; only a run kept nowhere is an error.
  if (!localOk && (failures.length || cloudNote)) {
    throw new Error(failures.length ? `${failures.length} détail(s) non enregistré(s) : ${failures[0]}` : (cloudNote as string));
  }
  return id;
}

/**
 * Frees online space for an incoming run: deletes the result files of the oldest unprotected
 * runs (their rows and local copies stay) until `need` bytes fit. False when pinned runs fill the quota.
 */
async function makeRoom(userId: string, quota: number, need: number, knownUsed: number): Promise<boolean> {
  if (need > quota) return false;
  const supabase = createClient();
  const { data } = await supabase
    .from('backtest_runs')
    .select('id,result_path,result_size,pinned')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1000);
  const rows = (data ?? []) as Pick<BacktestRunRow, 'id' | 'result_path' | 'result_size' | 'pinned'>[];
  const rowTotal = rows.reduce((n, r) => n + (r.result_size ?? 0), 0);
  let used = Math.max(knownUsed, rowTotal);
  if (used + need <= quota) return true;
  for (const r of rows) {
    if (used + need <= quota) return true;
    if (r.pinned || !r.result_size) continue;
    await deleteRun(r, { cloudOnly: true, keepRow: true });
    used -= r.result_size;
  }
  return used + need <= quota;
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------

const LIST_COLUMNS = 'id,label,engine,engine_version,duration_s,simulation_start,simulation_end,summary,warnings,result_path,result_size,created_at,kind,request_key,engine_code,details_partial,config_keys,portfolio_keys';

/** A run known only from its local meta.json (no longer, or never, online). */
function rowFromMeta(l: LocalRun): BacktestRunRow | null {
  const m = l.meta as Partial<BacktestRunRow> | null;
  if (!m || !Array.isArray(m.summary)) return null;
  const row: BacktestRunRow = {
    id: l.id,
    label: m.label ?? '',
    engine: m.engine ?? 'local',
    engine_version: m.engine_version ?? '',
    duration_s: m.duration_s ?? null,
    simulation_start: m.simulation_start ?? null,
    simulation_end: m.simulation_end ?? null,
    summary: m.summary,
    warnings: m.warnings ?? [],
    result_path: null,
    result_size: l.bytes,
    pinned: m.pinned === true,
    created_at: m.created_at ?? new Date(l.mtime * 1000).toISOString(),
    kind: m.kind ?? 'backtest',
    request_key: m.request_key ?? null,
    engine_code: m.engine_code ?? null,
    config_keys: m.config_keys ?? [],
    portfolio_keys: m.portfolio_keys ?? [],
    request: m.request,
    details_partial: false,
    cloud: false,
    local: true,
  };
  row.localFull = isLocalFull(row, l);
  return row;
}

/** Online rows merged with the local library; runs held only locally are added from their meta. */
function mergeRows(cloud: BacktestRunRow[], local: LocalRun[]): BacktestRunRow[] {
  const byLocal = new Map(local.map((l) => [l.id, l]));
  const rows: BacktestRunRow[] = cloud.map((r) => {
    const l = byLocal.get(r.id);
    return { ...r, cloud: true, local: !!l, localFull: isLocalFull(r, l) };
  });
  const seen = new Set(rows.map((r) => r.id));
  for (const l of local) {
    if (seen.has(l.id)) continue;
    const r = rowFromMeta(l);
    if (r) rows.push(r);
  }
  return rows;
}

/** Online rows + runs that exist only in the local library, pinned first then newest first. */
export async function listRuns(limit = 100): Promise<BacktestRunRow[]> {
  if (isGuest()) return [];
  const uid = await currentUid();
  const [cloud, local] = await Promise.all([
    createClient()
      .from('backtest_runs')
      .select(`${LIST_COLUMNS},pinned`)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(limit),
    uid ? localListRuns(uid, true) : Promise.resolve([] as LocalRun[]),
  ]);
  if (cloud.error && !local.length) throw new Error(cloud.error.message);
  return mergeRows((cloud.data ?? []) as BacktestRunRow[], local)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

/** A run whose full result can be opened without re-running (online, or in the local library). */
function reusable(r: BacktestRunRow): boolean {
  return (!!r.result_path && !r.details_partial) || !!r.localFull;
}

async function searchRows(
  match: (r: BacktestRunRow) => boolean,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cloudFilter: (q: any) => any,
  limit: number,
): Promise<BacktestRunRow[]> {
  if (isGuest()) return [];
  const uid = await currentUid();
  const [cloud, local] = await Promise.all([
    cloudFilter(createClient().from('backtest_runs').select(`${LIST_COLUMNS},pinned`)).order('created_at', { ascending: false }).limit(limit * 3),
    uid ? localListRuns(uid) : Promise.resolve([] as LocalRun[]),
  ]);
  if (cloud.error && !local.length) throw new Error(cloud.error.message);
  return mergeRows((cloud.data ?? []) as BacktestRunRow[], local)
    .filter((r) => match(r) && reusable(r))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit);
}

/** Saved runs holding at least one portfolio with one of these config keys, newest first. */
export async function findRunsByConfigKeys(keys: string[], limit = 60): Promise<BacktestRunRow[]> {
  if (!keys.length) return [];
  const set = new Set(keys);
  return searchRows((r) => (r.config_keys ?? []).some((k) => set.has(k)), (q) => q.overlaps('config_keys', keys), limit);
}

/** Saved runs made from exactly this request, newest first (only those that can be opened in full). */
export async function findRunsByKey(requestKey: string, limit = 5): Promise<BacktestRunRow[]> {
  return searchRows((r) => r.request_key === requestKey, (q) => q.eq('request_key', requestKey), limit);
}

export async function latestRun(kind: RunKind): Promise<BacktestRunRow | null> {
  const rows = await listRuns(30);
  return rows.find((r) => (r.kind ?? 'backtest') === kind && (!!r.result_path || r.local)) ?? null;
}

const latestTried = new Set<RunKind>();

/** Latest saved run of a kind, shown automatically once per page load by the view that needs it. */
export async function loadLatestOnce(kind: RunKind = 'backtest'): Promise<{ row: BacktestRunRow; result: LoadedResult } | null> {
  if (latestTried.has(kind)) return null;
  latestTried.add(kind);
  const latest = await latestRun(kind);
  if (!latest) return null;
  const { row, result } = await loadRun(latest.id);
  return result ? { row, result } : null;
}

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

export const RETENTION_DAYS = 30;
const CLEANUP_STAMP = 'backtester-history-cleanup';

/**
 * Deletes unprotected runs older than RETENTION_DAYS from the online storage (at most once a day
 * per browser). The local library follows its own setting (automatic cleaning in the engine).
 */
export async function cleanupOldRuns(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  if (typeof window === 'undefined' || isGuest() || localStorage.getItem(CLEANUP_STAMP) === today) return 0;
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 0;
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('backtest_runs')
    .select('id,result_path')
    .eq('pinned', false)
    .lt('created_at', cutoff)
    .limit(200);
  if (error) throw new Error(error.message);
  for (const row of data ?? []) await deleteRun(row as Pick<BacktestRunRow, 'id' | 'result_path'>, { cloudOnly: true });
  localStorage.setItem(CLEANUP_STAMP, today);
  return data?.length ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------

/** The saved row: online when it exists, else the copy kept next to the local files. */
export async function getRunRow(id: string): Promise<BacktestRunRow> {
  const { data, error } = await createClient().from('backtest_runs').select('*').eq('id', id).maybeSingle();
  if (data) return { ...(data as BacktestRunRow), cloud: true };
  const uid = await currentUid();
  if (uid) {
    const meta = await localGetRunFile(uid, id, 'meta.json');
    if (meta) {
      try {
        const m = JSON.parse(await meta.text()) as BacktestRunRow;
        return { ...m, result_path: null, cloud: false, local: true };
      } catch {
        /* fall through */
      }
    }
  }
  throw new Error(error?.message ?? 'Run introuvable');
}

type Reader = (name: string) => Promise<Blob | null>;

/**
 * Loads only the summary; portfolio details are read when a panel asks for them. Source "auto"
 * reads each file from the local library first, then online, and copies a file found online only
 * into the local library for next time. "local" / "cloud" (full accounts) read that source alone.
 */
export async function loadRun(id: string): Promise<{ row: BacktestRunRow; result: LoadedResult | null }> {
  const profile = isGuest() ? null : await getProfile();
  const uid = profile?.userId ?? null;
  const row = await getRunRow(id);
  const source = getResultSource(profile);
  const hasLocal = !!uid && localAvailable();
  const bucket = createClient().storage.from(RESULTS_BUCKET);

  // Format 1 (a single file holding everything) only ever lived online.
  if (row.result_path && !row.result_path.endsWith('/')) {
    const dl = await bucket.download(row.result_path);
    if (dl.error || !dl.data) return { row, result: null };
    return { row, result: bundleResult(`run:${id}`, toBundle(await readStoredJson(dl.data))) };
  }

  const folder = row.result_path;
  const cloudRead: Reader = async (name) => {
    if (!folder) return null;
    const d = await bucket.download(`${folder}${name}`);
    return d.error || !d.data ? null : d.data;
  };
  const localRead: Reader = async (name) => (hasLocal && uid ? localGetRunFile(uid, id, name) : null);
  const order: Reader[] = source === 'cloud' ? [cloudRead] : source === 'local' ? [localRead] : cloudFirst(profile) ? [cloudRead, localRead] : [localRead, cloudRead];
  let metaWritten = false;
  const read: Reader = async (name) => {
    for (const reader of order) {
      const blob = await reader(name);
      if (!blob) continue;
      if (reader === cloudRead && source === 'auto' && hasLocal && uid) {
        void localPutRunFile(uid, id, name, blob);
        if (!metaWritten) {
          metaWritten = true;
          void localPutMeta(uid, { ...row, result_path: null, cloud: undefined, local: undefined, localFull: undefined });
        }
      }
      return blob;
    }
    return null;
  };

  const summaryBlob = await read('summary.json.gz');
  if (!summaryBlob) return { row, result: null };
  const summary = toBundle(await readStoredJson(summaryBlob)).summary;
  return {
    row,
    result: {
      key: `run:${id}`,
      summary,
      detailsPartial: !!row.details_partial && !row.localFull,
      fetchDetail: async (i) => {
        const d = await read(`portfolio/${i}.json.gz`);
        return d ? ((await readStoredJson(d)) as PortfolioDetail) : null;
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------------------------

/**
 * Deletes a run: both copies by default. cloudOnly keeps the local library (used by the online
 * retention and quota), localOnly keeps the online one. keepRow leaves the database row (its
 * result files are gone; the run stays listed with its configuration and statistics).
 */
export async function deleteRun(
  row: Pick<BacktestRunRow, 'id' | 'result_path'> & { cloud?: boolean },
  opts: { cloudOnly?: boolean; localOnly?: boolean; keepRow?: boolean } = {},
): Promise<void> {
  const supabase = createClient();
  if (!opts.localOnly && row.cloud !== false) {
    const bucket = supabase.storage.from(RESULTS_BUCKET);
    // Allocations analyses live in <uid>/<runId>/allocations/ for both result formats.
    const uid = row.result_path?.split('/')[0] ?? (await currentUid());
    const analyses = uid ? await bucket.list(`${uid}/${row.id}/allocations`, { limit: 10000 }) : null;
    const analysisFiles = (analyses?.data ?? []).map((f) => `${uid}/${row.id}/allocations/${f.name}`);
    if (row.result_path?.endsWith('/')) {
      const folder = row.result_path;
      const [top, parts] = await Promise.all([
        bucket.list(folder.slice(0, -1), { limit: 1000 }),
        bucket.list(`${folder}portfolio`, { limit: 10000 }),
      ]);
      const files = [
        ...(top.data ?? []).filter((f) => f.id).map((f) => `${folder}${f.name}`),
        ...(parts.data ?? []).map((f) => `${folder}portfolio/${f.name}`),
        ...analysisFiles,
      ];
      for (let k = 0; k < files.length; k += 900) await bucket.remove(files.slice(k, k + 900));
    } else if (row.result_path) {
      await bucket.remove([row.result_path, ...analysisFiles]);
    } else if (analysisFiles.length) {
      await bucket.remove(analysisFiles);
    }
    if (opts.keepRow) {
      await supabase.from('backtest_runs').update({ result_path: null, result_size: 0, details_partial: true }).eq('id', row.id);
    } else {
      const { error } = await supabase.from('backtest_runs').delete().eq('id', row.id);
      if (error) throw new Error(error.message);
    }
  }
  if (!opts.cloudOnly) {
    const uid = await currentUid();
    if (uid) await localDeleteRun(uid, row.id);
  }
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const { error } = await createClient().from('backtest_runs').update({ pinned }).eq('id', id);
  if (error) throw new Error(error.message);
  const uid = await currentUid();
  if (uid) await localPatchMeta(uid, id, { pinned });
}

export async function renameRun(id: string, label: string): Promise<void> {
  const clean = label.slice(0, 200);
  const { error } = await createClient().from('backtest_runs').update({ label: clean }).eq('id', id);
  if (error) throw new Error(error.message);
  const uid = await currentUid();
  if (uid) await localPatchMeta(uid, id, { label: clean });
}
