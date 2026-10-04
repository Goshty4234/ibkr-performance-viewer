import type { EngineClient } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';

/**
 * The local library: the same results the site keeps online, stored in the data folder of the
 * engine running on this PC. Every function is a no-op (null / false) when no such engine answers,
 * so callers never have to check first, and a failure here never blocks the online copy.
 */

/** What the engine knows about one run it holds (meta = the saved run row, as the site wrote it). */
export interface LocalRun {
  id: string;
  bytes: number;
  files: number;
  summary: boolean;
  portfolios: number[];
  mtime: number;
  meta: Record<string, unknown> | null;
}

export function localClient(): EngineClient | null {
  const { engine, client } = useEngineStore.getState();
  return client && engine?.kind === 'local' && engine.health.library ? client : null;
}

export const localAvailable = (): boolean => localClient() !== null;

let listCache: { uid: string; at: number; runs: LocalRun[] } | null = null;
const LIST_TTL_MS = 4000;

export function invalidateLocalList(): void {
  listCache = null;
}

export async function localListRuns(uid: string, fresh = false): Promise<LocalRun[]> {
  const c = localClient();
  if (!c) return [];
  if (!fresh && listCache && listCache.uid === uid && Date.now() - listCache.at < LIST_TTL_MS) return listCache.runs;
  try {
    const { runs } = await c.libJson<{ runs: LocalRun[] }>(`runs/${uid}`);
    listCache = { uid, at: Date.now(), runs };
    return runs;
  } catch {
    return [];
  }
}

export async function localPutRunFile(uid: string, run: string, name: string, data: Blob | string): Promise<boolean> {
  const c = localClient();
  if (!c) return false;
  try {
    await c.libPut(`runs/${uid}/${run}/${name}`, data);
    invalidateLocalList();
    return true;
  } catch {
    return false;
  }
}

export async function localGetRunFile(uid: string, run: string, name: string): Promise<Blob | null> {
  const c = localClient();
  if (!c) return null;
  try {
    return await c.libGet(`runs/${uid}/${run}/${name}`);
  } catch {
    return null;
  }
}

export async function localDeleteRun(uid: string, run: string): Promise<boolean> {
  const c = localClient();
  if (!c) return false;
  try {
    await c.libDelete(`runs/${uid}/${run}`);
    invalidateLocalList();
    return true;
  } catch {
    return false;
  }
}

/** Rewrites the run's meta.json: the saved row, used to list a run that is no longer online. */
export function localPutMeta(uid: string, row: { id: string } & Record<string, unknown>): Promise<boolean> {
  return localPutRunFile(uid, row.id, 'meta.json', JSON.stringify(row));
}

/** Merges fields into the stored meta (pin, rename...). */
export async function localPatchMeta(uid: string, run: string, patch: Record<string, unknown>): Promise<boolean> {
  const blob = await localGetRunFile(uid, run, 'meta.json');
  if (!blob) return false;
  try {
    const meta = JSON.parse(await blob.text()) as Record<string, unknown>;
    return localPutMeta(uid, { ...meta, ...patch, id: run });
  } catch {
    return false;
  }
}

export async function localPutIbkr(uid: string, name: string, data: Blob | string): Promise<boolean> {
  const c = localClient();
  if (!c) return false;
  try {
    await c.libPut(`ibkr/${uid}/${encodeURIComponent(name)}`, data);
    return true;
  } catch {
    return false;
  }
}

export async function localGetIbkr(uid: string, name: string): Promise<Blob | null> {
  const c = localClient();
  if (!c) return null;
  try {
    return await c.libGet(`ibkr/${uid}/${encodeURIComponent(name)}`);
  } catch {
    return null;
  }
}

export async function localPutConfigs(uid: string, data: string): Promise<boolean> {
  const c = localClient();
  if (!c) return false;
  try {
    await c.libPut(`configs/${uid}`, data);
    return true;
  } catch {
    return false;
  }
}
