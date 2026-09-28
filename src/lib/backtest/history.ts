import { createClient } from '@/lib/supabase/client';
import type { PortfolioConfig, PortfolioDetail, ResultSummary, RunOptions } from '@/lib/engine/types';
import { bundleResult, type LoadedResult, toBundle } from './result-data';

export const RESULTS_BUCKET = 'backtest-results';
const UPLOAD_CONCURRENCY = 6;

export interface RunSummaryRow {
  name: string;
  ok: boolean;
  cagr?: string;
  maxdd?: string;
  sharpe?: string;
  final?: number | null;
}

/**
 * result_path: "<uid>/<runId>/" (format 2: summary.json.gz + portfolio/<i>.json.gz)
 * or "<uid>/<runId>.json.gz" (format 1: one file).
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
  request?: { portfolios: PortfolioConfig[]; options: Partial<RunOptions> };
}

async function gzip(text: string): Promise<Blob> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  const stream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function readMaybeGzip(blob: Blob): Promise<string> {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b ? gunzip(blob) : blob.text();
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

/** Result produced by the CLI / GitHub Actions / engine /result (.json.gz or .json, any format). */
export async function readResultFile(file: Blob, name: string): Promise<LoadedResult> {
  const bundle = toBundle(JSON.parse(await readMaybeGzip(file)));
  return bundleResult(`file:${name}:${file.size}`, bundle);
}

export function summarize(summary: ResultSummary): RunSummaryRow[] {
  return summary.portfolios.map((p) =>
    p.ok
      ? {
          name: p.name,
          ok: true,
          cagr: p.stats_display.CAGR,
          maxdd: p.stats_display.MaxDrawdown,
          sharpe: p.stats_display.Sharpe,
          final: p.stats['Final Value (with)'] ?? null,
        }
      : { name: p.name, ok: false },
  );
}

/**
 * Stores the summary first (the run is usable as soon as it is there), then
 * every detail chunk in parallel. Returns the run id.
 */
export async function saveRun(args: {
  label: string;
  engine: string;
  request: { portfolios: PortfolioConfig[]; options: Partial<RunOptions> };
  summary: ResultSummary;
  summaryText: string;
  detailText: (index: number) => Promise<string>;
}): Promise<string | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const id = crypto.randomUUID();
  const folder = `${user.id}/${id}/`;
  const bucket = supabase.storage.from(RESULTS_BUCKET);
  const summaryBlob = await gzip(args.summaryText);
  const up = await bucket.upload(`${folder}summary.json.gz`, summaryBlob, { contentType: 'application/gzip', upsert: true });
  if (up.error) throw new Error(`Stockage : ${up.error.message}`);
  let size = summaryBlob.size;
  const s = args.summary;
  const { error } = await supabase.from('backtest_runs').insert({
    id,
    user_id: user.id,
    label: args.label.slice(0, 200),
    request: args.request,
    engine: args.engine,
    engine_version: s.engine_version,
    duration_s: s.duration_s,
    simulation_start: s.simulation.display_start ?? s.simulation.start,
    simulation_end: s.simulation.end,
    summary: summarize(s),
    warnings: s.warnings.slice(0, 50),
    result_path: folder,
    result_size: size,
  });
  if (error) throw new Error(error.message);

  const indices = s.portfolios.filter((p) => p.ok).map((p) => p.index);
  const failures: string[] = [];
  await pool(indices, UPLOAD_CONCURRENCY, async (i) => {
    try {
      const blob = await gzip(await args.detailText(i));
      const r = await bucket.upload(`${folder}portfolio/${i}.json.gz`, blob, { contentType: 'application/gzip', upsert: true });
      if (r.error) failures.push(`${i}: ${r.error.message}`);
      else size += blob.size;
    } catch (e) {
      failures.push(`${i}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  await supabase.from('backtest_runs').update({ result_size: size }).eq('id', id);
  if (failures.length) throw new Error(`${failures.length} détail(s) non enregistré(s) : ${failures[0]}`);
  return id;
}

export async function listRuns(limit = 100): Promise<BacktestRunRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('backtest_runs')
    .select('id,label,engine,engine_version,duration_s,simulation_start,simulation_end,summary,warnings,result_path,result_size,pinned,created_at')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []) as BacktestRunRow[];
}

export async function getRunRow(id: string): Promise<BacktestRunRow> {
  const { data, error } = await createClient().from('backtest_runs').select('*').eq('id', id).single();
  if (error || !data) throw new Error(error?.message ?? 'Run introuvable');
  return data as BacktestRunRow;
}

/** Loads only the summary; portfolio details are downloaded when a panel asks for them. */
export async function loadRun(id: string): Promise<{ row: BacktestRunRow; result: LoadedResult | null }> {
  const supabase = createClient();
  const row = await getRunRow(id);
  if (!row.result_path) return { row, result: null };
  const bucket = supabase.storage.from(RESULTS_BUCKET);
  if (!row.result_path.endsWith('/')) {
    const dl = await bucket.download(row.result_path);
    if (dl.error || !dl.data) return { row, result: null };
    return { row, result: bundleResult(`run:${id}`, toBundle(JSON.parse(await readMaybeGzip(dl.data)))) };
  }
  const folder = row.result_path;
  const dl = await bucket.download(`${folder}summary.json.gz`);
  if (dl.error || !dl.data) return { row, result: null };
  const summary = toBundle(JSON.parse(await readMaybeGzip(dl.data))).summary;
  return {
    row,
    result: {
      key: `run:${id}`,
      summary,
      fetchDetail: async (i) => {
        const d = await bucket.download(`${folder}portfolio/${i}.json.gz`);
        if (d.error || !d.data) return null;
        return JSON.parse(await readMaybeGzip(d.data)) as PortfolioDetail;
      },
    },
  };
}

let latestTried = false;

/** Latest saved run, shown automatically once per page load by whichever view needs a result first. */
export async function loadLatestOnce(): Promise<{ row: BacktestRunRow; result: LoadedResult } | null> {
  if (latestTried) return null;
  latestTried = true;
  const [latest] = await listRuns(1);
  if (!latest) return null;
  const { row, result } = await loadRun(latest.id);
  return result ? { row, result } : null;
}

export async function deleteRun(row: Pick<BacktestRunRow, 'id' | 'result_path'>): Promise<void> {
  const supabase = createClient();
  const bucket = supabase.storage.from(RESULTS_BUCKET);
  // Allocations analyses live in <uid>/<runId>/allocations/ for both result formats.
  const uid = row.result_path?.split('/')[0];
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
  }
  const { error } = await supabase.from('backtest_runs').delete().eq('id', row.id);
  if (error) throw new Error(error.message);
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('backtest_runs').update({ pinned }).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function renameRun(id: string, label: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('backtest_runs').update({ label: label.slice(0, 200) }).eq('id', id);
  if (error) throw new Error(error.message);
}
