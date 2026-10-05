import { isGuest } from '@/lib/guest';
import { getProfile } from '@/lib/storage/profile';
import { localClient } from '@/lib/storage/local-library';
import type { McOptions, McResult } from './montecarlo';

/**
 * Saved Monte Carlo runs live in the data folder of the engine on this PC (<data>/montecarlo_runs/<user>/<run>/), like the
 * normal runs live in <data>/backtests: nothing goes to the online database. Every function is a no-op (null / []) when no
 * local engine answers (or on an engine too old to know the route), and none of them throws: a failed save never disturbs
 * the page. The engine keeps the 20 most recent runs of a user.
 */

export interface McSavedMeta {
  id: string;
  created_at: string;
  n_draws: number;
  n_pick: number;
  portfolios: string[];
  options: McOptions;
  start: string;
  end: string;
}

export interface McSavedRun {
  id: string;
  bytes: number;
  mtime: number;
  meta: McSavedMeta | null;
}

async function uid(): Promise<string | null> {
  if (isGuest()) return null;
  try {
    return (await getProfile())?.userId ?? null;
  } catch {
    return null;
  }
}

async function gzip(text: string): Promise<Blob> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
}

async function gunzip(blob: Blob): Promise<string> {
  return new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
}

const newId = (): string => `mc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Stores a finished run; returns its id, or null when nothing could be stored. */
export async function saveMcRun(result: McResult, options: McOptions): Promise<string | null> {
  const c = localClient();
  const u = await uid();
  if (!c || !u) return null;
  try {
    const id = newId();
    const meta: McSavedMeta = {
      id,
      created_at: new Date().toISOString(),
      n_draws: result.draws.length,
      n_pick: options.n_pick,
      portfolios: result.series.filter((s) => s.kind === 'portfolio').map((s) => s.name),
      options,
      start: result.dates[0] ?? '',
      end: result.dates[result.dates.length - 1] ?? '',
    };
    // The result goes first: the engine lists a run only once it has one, and prunes old runs when the meta arrives.
    await c.libPut(`montecarlo/${u}/${id}/result.json.gz`, await gzip(JSON.stringify(result)));
    await c.libPut(`montecarlo/${u}/${id}/meta.json`, JSON.stringify(meta));
    return id;
  } catch {
    return null;
  }
}

export async function listMcRuns(): Promise<McSavedRun[]> {
  const c = localClient();
  const u = await uid();
  if (!c || !u) return [];
  try {
    return (await c.libJson<{ runs: McSavedRun[] }>(`montecarlo/${u}`)).runs;
  } catch {
    return [];
  }
}

export async function loadMcRun(id: string): Promise<McResult | null> {
  const c = localClient();
  const u = await uid();
  if (!c || !u) return null;
  try {
    const blob = await c.libGet(`montecarlo/${u}/${id}/result.json.gz`);
    if (!blob) return null;
    const r = JSON.parse(await gunzip(blob)) as McResult;
    return Array.isArray(r?.series) && Array.isArray(r?.dates) && Array.isArray(r?.draws) ? r : null;
  } catch {
    return null;
  }
}

export async function deleteMcRun(id: string): Promise<boolean> {
  const c = localClient();
  const u = await uid();
  if (!c || !u) return false;
  try {
    await c.libDelete(`montecarlo/${u}/${id}`);
    return true;
  } catch {
    return false;
  }
}
