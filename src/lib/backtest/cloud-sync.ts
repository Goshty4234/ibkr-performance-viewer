'use client';

import { clientStorage, isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import type { RunOptions } from '@/lib/engine/types';
import { DEFAULT_OPTIONS, type EditablePortfolio } from './portfolio';
import { useBacktestStore } from './store';

/**
 * Keeps the builder draft and the real portfolio values (Allocations) in
 * user_settings so every device sees the same workspace. Last writer wins,
 * compared on the timestamp of the last local edit.
 */

const PUSH_DELAY_MS = 1500;
const PULL_MIN_INTERVAL_MS = 10_000;
const WS_STAMP_KEY = 'backtester-workspace-at';
const VALUES_STAMP_KEY = 'alloc-values-at';
const VALUE_PREFIX = 'alloc-value:';
export const VALUES_EVENT = 'alloc-values-changed';

interface Workspace {
  portfolios: EditablePortfolio[];
  selectedId: string | null;
  options: RunOptions;
}

interface ValuesDoc {
  at: number;
  values: Record<string, number>;
}

let started = false;
let applying = false;
let userId: string | null | undefined;
let wsTimer: ReturnType<typeof setTimeout> | null = null;
let valuesTimer: ReturnType<typeof setTimeout> | null = null;
let lastPull = 0;

const stamp = (key: string) => Number(window.localStorage.getItem(key)) || 0;
const setStamp = (key: string, at: number) => window.localStorage.setItem(key, String(at));

async function currentUser(): Promise<string | null> {
  if (userId === undefined) {
    const { data: { user } } = await createClient().auth.getUser();
    userId = user?.id ?? null;
  }
  return userId;
}

function readLocalValues(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (!k?.startsWith(VALUE_PREFIX)) continue;
    const n = Number(window.localStorage.getItem(k));
    if (Number.isFinite(n) && n > 0) out[k.slice(VALUE_PREFIX.length)] = n;
  }
  return out;
}

function replaceLocalValues(values: Record<string, number>): void {
  const stale: string[] = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (k?.startsWith(VALUE_PREFIX)) stale.push(k);
  }
  stale.forEach((k) => window.localStorage.removeItem(k));
  for (const [name, v] of Object.entries(values)) window.localStorage.setItem(VALUE_PREFIX + name, String(v));
  window.dispatchEvent(new Event(VALUES_EVENT));
}

async function pushWorkspace(): Promise<void> {
  wsTimer = null;
  const id = await currentUser();
  if (!id) return;
  const s = useBacktestStore.getState();
  const at = stamp(WS_STAMP_KEY) || Date.now();
  const workspace: Workspace = { portfolios: s.portfolios, selectedId: s.selectedId, options: s.options };
  await createClient().from('user_settings').upsert(
    { user_id: id, backtest_workspace: workspace, backtest_workspace_at: new Date(at).toISOString() },
    { onConflict: 'user_id' },
  );
}

async function pushValues(): Promise<void> {
  valuesTimer = null;
  const id = await currentUser();
  if (!id) return;
  const doc: ValuesDoc = { at: stamp(VALUES_STAMP_KEY) || Date.now(), values: readLocalValues() };
  await createClient().from('user_settings').upsert({ user_id: id, allocation_values: doc }, { onConflict: 'user_id' });
}

function scheduleWorkspace(): void {
  if (wsTimer) clearTimeout(wsTimer);
  wsTimer = setTimeout(() => void pushWorkspace().catch(() => {}), PUSH_DELAY_MS);
}

function scheduleValues(): void {
  if (valuesTimer) clearTimeout(valuesTimer);
  valuesTimer = setTimeout(() => void pushValues().catch(() => {}), PUSH_DELAY_MS);
}

async function pull(): Promise<void> {
  lastPull = Date.now();
  const id = await currentUser();
  if (!id) return;
  const { data, error } = await createClient()
    .from('user_settings')
    .select('backtest_workspace, backtest_workspace_at, allocation_values')
    .eq('user_id', id)
    .maybeSingle();
  if (error) return;

  const ws = data?.backtest_workspace as Workspace | null | undefined;
  const remoteAt = data?.backtest_workspace_at ? Date.parse(data.backtest_workspace_at) : 0;
  const localAt = stamp(WS_STAMP_KEY);
  if (ws?.portfolios && remoteAt > localAt && !wsTimer) {
    applying = true;
    try {
      useBacktestStore.setState({
        portfolios: ws.portfolios,
        selectedId: ws.selectedId ?? ws.portfolios[0]?._id ?? null,
        options: { ...DEFAULT_OPTIONS, ...ws.options },
      });
    } finally {
      applying = false;
    }
    setStamp(WS_STAMP_KEY, remoteAt);
  } else if (localAt > remoteAt || !ws) {
    if (!localAt) setStamp(WS_STAMP_KEY, Date.now());
    scheduleWorkspace();
  }

  const values = data?.allocation_values as ValuesDoc | null | undefined;
  const localValuesAt = stamp(VALUES_STAMP_KEY);
  if (values?.values && values.at > localValuesAt && !valuesTimer) {
    replaceLocalValues(values.values);
    setStamp(VALUES_STAMP_KEY, values.at);
  } else if (localValuesAt > (values?.at ?? 0) || (!values && Object.keys(readLocalValues()).length)) {
    if (!localValuesAt) setStamp(VALUES_STAMP_KEY, Date.now());
    scheduleValues();
  }
}

function flush(): void {
  if (wsTimer) { clearTimeout(wsTimer); void pushWorkspace().catch(() => {}); }
  if (valuesTimer) { clearTimeout(valuesTimer); void pushValues().catch(() => {}); }
}

export function startCloudSync(): void {
  if (started || typeof window === 'undefined' || isGuest()) return;
  started = true;
  useBacktestStore.subscribe((s, prev) => {
    if (applying) return;
    if (s.portfolios !== prev.portfolios || s.options !== prev.options || s.selectedId !== prev.selectedId) {
      setStamp(WS_STAMP_KEY, Date.now());
      scheduleWorkspace();
    }
  });
  const maybePull = () => {
    if (document.visibilityState === 'visible' && Date.now() - lastPull > PULL_MIN_INTERVAL_MS) void pull().catch(() => {});
  };
  window.addEventListener('focus', maybePull);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    else maybePull();
  });
  window.addEventListener('pagehide', flush);
  void pull().catch(() => {});
}

/** Real portfolio value typed in Allocations (null = use the backtest value). */
export function readMyValue(name: string): number | null {
  const raw = clientStorage().getItem(VALUE_PREFIX + name);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function writeMyValue(name: string, v: number | null): void {
  const storage = clientStorage();
  if (v === null) storage.removeItem(VALUE_PREFIX + name);
  else storage.setItem(VALUE_PREFIX + name, String(v));
  if (isGuest()) return;
  setStamp(VALUES_STAMP_KEY, Date.now());
  scheduleValues();
}
