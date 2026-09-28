'use client';

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { clientStorage } from '@/lib/guest';
import { EngineClient, type EngineKind, type ResolvedEngine } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import type { EngineJob, PortfolioConfig, ResultSummary, RunOptions, StockConfig } from '@/lib/engine/types';
import { alignToCycle, allocationOptions, allocationWindow, needsCycleAnchor } from './allocation-window';
import { type BacktestRunRow, findRunsByConfigKeys, findRunsByKey, loadRun, type RunKind, saveRun } from './history';
import type { LoadedResult } from './result-data';
import { buildOffer, decide, type MergePart, mergeResults, type ReuseDecision, type ReuseOffer } from './reuse';
import { configKeys, requestKey, type RunRequest, sameMarketData, sameNyDay } from './run-key';
import {
  DEFAULT_OPTIONS,
  defaultPortfolio,
  type EditablePortfolio,
  newId,
  parseImport,
  toEngineConfig,
  uniqueName,
  validatePortfolios,
} from './portfolio';
import { isInverse, resolveTicker } from './tickers';

export type RunPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'fetching' | 'done' | 'error' | 'cancelled';
export type BacktestView = 'build' | 'results' | 'allocations' | 'history';

/** A backtest result loaded while on the Allocations page waits in Résultats without moving the user. */
const resultView = (current: BacktestView): BacktestView => (current === 'allocations' ? 'allocations' : 'results');

/** Allocations has its own result, independent of the one shown in Résultats. */
export interface AllocSlot {
  result: LoadedResult;
  runId: string | null;
  label: string;
  source: 'run' | 'history';
  /** Portfolio the analysis was asked for (a fusion run also carries its members). */
  focus: string | null;
  saveError: string | null;
}

/** Answer to the "already computed" dialog; `accepted` = positions whose stored result is taken. */
export type ReuseChoice = { action: 'reuse'; accepted: number[] } | { action: 'fresh' } | { action: 'cancel' };

/** A run completed with portfolio results taken from earlier runs. */
export interface MergeSpec {
  reused: { position: number; runId: string; index: number }[];
  /** Positions computed by this job, in job order. */
  computed: number[];
  planKeys: (string | null)[];
  /** The whole request, end date set to the common end. */
  request: RunRequest;
  configKeys: string[];
}

/** Shown above a result that was reopened instead of recomputed. */
export interface ReuseNotice {
  purpose: RunKind;
  createdAt: string;
  label: string;
  rerun: () => void;
  /** Prices have not moved since: identical to a new run (otherwise same day, intraday prices). */
  exact: boolean;
}

const AUTO_REUSE_KEY = 'backtester-reuse-auto';

export function autoReuse(): boolean {
  return typeof window !== 'undefined' && localStorage.getItem(AUTO_REUSE_KEY) === '1';
}

export function setAutoReuse(on: boolean) {
  if (on) localStorage.setItem(AUTO_REUSE_KEY, '1');
  else localStorage.removeItem(AUTO_REUSE_KEY);
}

export interface RunState {
  id: string;
  phase: RunPhase;
  job: EngineJob | null;
  engineUrl: string | null;
  engineKind: EngineKind | null;
  authRequired: boolean;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  label: string;
  portfolioCount: number;
  savedId: string | null;
  request: { portfolios: PortfolioConfig[]; options: RunOptions } | null;
  purpose?: RunKind;
  requestKey?: string | null;
  engineCode?: string | null;
  /** Portfolio an Allocations run was launched for. */
  focus?: string | null;
  /** Aligned with request.portfolios. */
  configKeys?: string[];
  merge?: MergeSpec | null;
  reusedCount?: number;
}

export const ACTIVE_PHASES: readonly RunPhase[] = ['submitting', 'queued', 'running', 'fetching'];
export const isActive = (r: RunState) => ACTIVE_PHASES.includes(r.phase);
const MAX_KEPT_RUNS = 12;

interface BacktestState {
  portfolios: EditablePortfolio[];
  selectedId: string | null;
  options: RunOptions;
  view: BacktestView;
  /** Newest first. Several jobs can run at once on the engine pool. */
  runs: RunState[];
  /** Error raised before any job could be created (no engine, …). */
  launchError: string | null;
  result: LoadedResult | null;
  resultRunId: string | null;
  resultLabel: string;
  resultSource: 'run' | 'history' | 'file';
  saveError: string | null;
  alloc: AllocSlot | null;
  reuseOffer: ReuseOffer | null;
  reuseNotice: ReuseNotice | null;

  select: (id: string) => void;
  setView: (v: BacktestView) => void;
  addPortfolio: () => void;
  duplicatePortfolio: (id: string) => void;
  removePortfolio: (id: string) => void;
  movePortfolio: (id: string, delta: number) => void;
  updatePortfolio: (id: string, patch: Partial<EditablePortfolio>) => void;
  /** Back to the default settings, keeping the name (Streamlit "Reset Selected Portfolio"). */
  resetPortfolio: (id: string) => void;
  renamePortfolio: (id: string, name: string) => void;
  updateStock: (id: string, index: number, patch: Partial<StockConfig>) => void;
  addStocks: (id: string, tickers: string[]) => void;
  removeStock: (id: string, index: number) => void;
  equalizeStocks: (id: string) => void;
  setOptions: (patch: Partial<RunOptions>) => void;
  /** 'active' = a single pasted portfolio replaces the selected one (Streamlit "Update with Pasted JSON"). */
  importJson: (text: string, mode: 'replace' | 'append' | 'active') => number;
  commitName: (id: string) => void;
  removePortfolios: (ids: string[]) => void;
  syncFromFirst: (what: 'cashflow' | 'rebalancing') => number;
  addVariants: (baseId: string, variants: EditablePortfolio[], keepBase: boolean) => void;
  createFusion: (name: string, allocations: Record<string, number>, frequency: string) => void;
  replaceAll: (portfolios: EditablePortfolio[], options?: Partial<RunOptions>) => void;
  /**
   * Resolves with the run id once the job is submitted (null when nothing was launched, or when
   * everything came from saved runs). `force` skips the search for already computed portfolios.
   */
  startRun: (onlyIds?: string[], opts?: { force?: boolean }) => Promise<string | null>;
  /** Today's target for one portfolio (+ its fusion members) on the shortest exact window. */
  startAllocationRun: (portfolioId: string, opts?: { force?: boolean }) => Promise<string | null>;
  resolveReuse: (choice: ReuseChoice) => void;
  dismissReuseNotice: () => void;
  showAllocResult: (result: LoadedResult, runId: string | null, label: string, focus?: string | null) => void;
  cancelRun: (id: string) => Promise<void>;
  dismissRun: (id: string) => void;
  openRun: (id: string) => Promise<void>;
  resumeRun: () => void;
  showResult: (result: LoadedResult, runId: string | null, label: string) => void;
}

const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Finished results kept in memory (not persisted) so any finished run can be reopened instantly. */
const runResults = new Map<string, LoadedResult>();
let reuseResolver: ((choice: ReuseChoice) => void) | null = null;

const NO_ENGINE = 'Aucun moteur disponible. Lance le moteur sur ton PC ou configure le moteur en ligne.';

/** Saved results matching portfolios of this request exactly (engine-confirmed), or null. */
async function findOffer(engine: ResolvedEngine, request: RunRequest, keys: string[]): Promise<ReuseOffer | null> {
  const rows = await findRunsByConfigKeys([...new Set(keys)]).catch(() => [] as BacktestRunRow[]);
  if (!rows.length) return null;
  try {
    const plan = await new EngineClient(engine.url, engine.health.auth_required).plan(request.portfolios, request.options);
    return buildOffer(request, plan, rows);
  } catch {
    return null;
  }
}

async function composeMerge(merge: MergeSpec, job: LoadedResult | null, key: string): Promise<LoadedResult> {
  const loaded = new Map<string, LoadedResult>();
  for (const r of merge.reused) {
    if (loaded.has(r.runId)) continue;
    const { result } = await loadRun(r.runId);
    if (!result) throw new Error('un run repris n’a plus de résultat stocké');
    loaded.set(r.runId, result);
  }
  const parts: MergePart[] = [
    ...(job ? merge.computed.map((position, index) => ({ position, result: job, index, historyKey: merge.planKeys[position] ?? null })) : []),
    ...merge.reused.map((r) => ({ position: r.position, result: loaded.get(r.runId)!, index: r.index, historyKey: merge.planKeys[r.position] ?? null })),
  ];
  return mergeResults(key, merge.request.options, parts);
}

/**
 * Newest saved run of this exact request that read the same market data a launch now would
 * (or, with `sameDay`, any run of today: a day's target barely moves intraday).
 */
async function findReusable(key: string, request: RunRequest, engineCode: string | undefined, sameDay = false): Promise<BacktestRunRow | null> {
  const rows = await findRunsByKey(key).catch(() => [] as BacktestRunRow[]);
  return rows.find((r) => {
    const at = new Date(r.created_at);
    return (sameMarketData(at, request) || (sameDay && sameNyDay(at)))
      && (!engineCode || !r.engine_code || r.engine_code === engineCode);
  }) ?? null;
}

function stopPolling(id: string) {
  const t = pollTimers.get(id);
  if (t) clearTimeout(t);
  pollTimers.delete(id);
}

function runLabel(names: string[]): string {
  return names.length <= 3 ? names.join(' · ') : `${names.slice(0, 2).join(' · ')} +${names.length - 2}`;
}

export const useBacktestStore = create<BacktestState>()(
  persist(
    (set, get) => {
      const patchPortfolio = (id: string, fn: (p: EditablePortfolio) => EditablePortfolio) =>
        set((s) => ({ portfolios: s.portfolios.map((p) => (p._id === id ? fn(p) : p)) }));

      const getRun = (id: string) => get().runs.find((r) => r.id === id);
      const patchRun = (id: string, patch: Partial<RunState>) =>
        set((s) => ({ runs: s.runs.map((r) => (r.id === id ? { ...r, ...patch } : r)) }));

      function presentResult(run: RunState, result: LoadedResult, switchView: boolean) {
        if (run.purpose === 'allocations') {
          set((s) => ({
            alloc: { result, runId: run.savedId, label: run.label, source: 'run', focus: run.focus ?? null, saveError: null },
            reuseNotice: s.reuseNotice?.purpose === 'allocations' ? null : s.reuseNotice,
            ...(switchView ? { view: 'allocations' as const } : {}),
          }));
          return;
        }
        set((s) => ({
          result,
          resultRunId: run.savedId,
          resultLabel: run.label,
          resultSource: 'run',
          saveError: null,
          reuseNotice: s.reuseNotice?.purpose === 'backtest' ? null : s.reuseNotice,
          ...(switchView ? { view: 'results' as const } : {}),
        }));
      }

      /** Current slot holding `result` (Résultats or Allocations), to attach its saved id or error. */
      function patchSlotOf(result: LoadedResult, patch: { runId?: string | null; saveError?: string }) {
        if (get().result === result) {
          set({
            ...(patch.runId !== undefined ? { resultRunId: patch.runId } : {}),
            ...(patch.saveError !== undefined ? { saveError: patch.saveError } : {}),
          });
        }
        const a = get().alloc;
        if (a?.result === result) {
          set({ alloc: { ...a, ...(patch.runId !== undefined ? { runId: patch.runId } : {}), ...(patch.saveError !== undefined ? { saveError: patch.saveError } : {}) } });
        }
      }

      function savedIdOf(result: LoadedResult): string | null {
        if (get().result === result) return get().resultRunId;
        const a = get().alloc;
        return a?.result === result ? a.runId : null;
      }

      async function openSaved(row: BacktestRunRow, purpose: RunKind, focus: string | null, rerun: () => void, request: RunRequest): Promise<boolean> {
        const { result } = await loadRun(row.id);
        if (!result) return false;
        const exact = sameMarketData(new Date(row.created_at), request);
        const notice: ReuseNotice = { purpose, createdAt: row.created_at, label: row.label, rerun, exact };
        if (purpose === 'allocations') {
          set({ alloc: { result, runId: row.id, label: row.label, source: 'history', focus, saveError: null }, reuseNotice: notice });
        } else {
          set({ result, resultRunId: row.id, resultLabel: row.label, resultSource: 'history', saveError: null, view: 'results', reuseNotice: notice });
        }
        return true;
      }

      function askReuse(offer: ReuseOffer): Promise<ReuseChoice> {
        reuseResolver?.({ action: 'cancel' });
        return new Promise((resolve) => {
          reuseResolver = resolve;
          set({ reuseOffer: offer });
        });
      }

      /** Runs only what is missing on the saved runs' date axis, then stitches everything together. */
      async function launchWithReuse(engine: ResolvedEngine, offer: ReuseOffer, decision: ReuseDecision, label: string, keys: string[]): Promise<string | null> {
        const { request, plan } = offer;
        const options: RunOptions = { ...request.options, end_date: decision.end };
        const full: RunRequest = { portfolios: request.portfolios.map((p) => ({ ...p, end_date_user: decision.end })), options };
        const merge: MergeSpec = {
          reused: [...decision.reuse].map(([position, s]) => ({ position, runId: s.row.id, index: s.index })),
          computed: decision.compute,
          planKeys: plan.portfolios.map((p) => p.history_key),
          request: full,
          configKeys: keys,
        };
        const extra: Partial<RunState> = { purpose: 'backtest', merge, reusedCount: merge.reused.length, configKeys: keys };
        if (!decision.compute.length) {
          const id = newId();
          const result = await composeMerge(merge, null, `merge:${id}`);
          const run: RunState = {
            id, phase: 'done', job: null, engineUrl: null, engineKind: engine.kind, authRequired: false, error: null,
            startedAt: Date.now(), finishedAt: Date.now(), label, portfolioCount: full.portfolios.length, savedId: null,
            request: full, engineCode: engine.health.code ?? null, ...extra,
          };
          set((s) => ({ runs: [run, ...s.runs].slice(0, MAX_KEPT_RUNS), launchError: null }));
          await present(run.id, result, result.summary, JSON.stringify(result.summary), async (i) => JSON.stringify(await result.fetchDetail(i)));
          return null;
        }
        const subset: RunRequest = {
          portfolios: decision.compute.map((pos) => full.portfolios[pos]),
          options: { ...options, align_start: plan.simulation.start },
        };
        return launch(engine, subset, label, extra);
      }

      async function engineForRun(): Promise<ResolvedEngine | null> {
        const engineState = useEngineStore.getState();
        return engineState.engine ?? (await engineState.detect());
      }

      async function launch(engine: ResolvedEngine, request: RunRequest, label: string, extra: Partial<RunState>): Promise<string> {
        const run: RunState = {
          id: newId(), phase: 'submitting', job: null, engineUrl: engine.url, engineKind: engine.kind,
          authRequired: engine.health.auth_required, error: null, startedAt: Date.now(), finishedAt: null, label,
          portfolioCount: request.portfolios.length, savedId: null, request, engineCode: engine.health.code ?? null, ...extra,
        };
        set((s) => {
          const kept = [run, ...s.runs];
          const active = kept.filter(isActive);
          const finished = kept.filter((r) => !isActive(r)).slice(0, Math.max(0, MAX_KEPT_RUNS - active.length));
          const keep = new Set([...active, ...finished].map((r) => r.id));
          for (const r of s.runs) if (!keep.has(r.id)) runResults.delete(r.id);
          return { runs: kept.filter((r) => keep.has(r.id)), launchError: null };
        });
        const client = new EngineClient(engine.url, engine.health.auth_required);
        try {
          const job = await client.submit(request.portfolios, request.options, label);
          patchRun(run.id, { job, phase: job.status as RunPhase });
          poll(client, run.id, job.id, 250);
        } catch (e) {
          patchRun(run.id, { phase: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() });
        }
        return run.id;
      }

      async function finish(client: EngineClient, runId: string, job: EngineJob) {
        const jobId = job.id;
        patchRun(runId, { job, phase: 'fetching' });
        const summaryText = await client.summaryText(jobId);
        const summary = JSON.parse(summaryText) as ResultSummary;
        const result: LoadedResult = {
          key: `job:${jobId}`,
          summary,
          // Engine results expire (TTL / restart): fall back to the saved copy.
          fetchDetail: async (i) => {
            try {
              return await client.portfolio(jobId, i);
            } catch (e) {
              // A merged run is saved with other chunk numbers: its copy cannot stand in for this job.
              const savedId = getRun(runId)?.merge ? null : (getRun(runId)?.savedId ?? savedIdOf(result));
              if (!savedId) throw e;
              const saved = await loadRun(savedId);
              return saved.result ? saved.result.fetchDetail(i) : null;
            }
          },
        };
        const merge = getRun(runId)?.merge;
        if (!merge) {
          await present(runId, result, summary, summaryText, (i) => client.portfolioText(jobId, i));
          return;
        }
        const drifted = merge.computed.some((pos, i) => {
          const piece = summary.portfolios.find((p) => p.index === i);
          return piece?.ok && piece.history_key !== merge.planKeys[pos];
        });
        let merged: LoadedResult | null = null;
        let failure = drifted ? 'calcul partiel différent du calcul complet' : '';
        if (!drifted) {
          try {
            merged = await composeMerge(merge, result, `merge:${runId}`);
          } catch (e) {
            failure = e instanceof Error ? e.message : String(e);
          }
        }
        if (!merged) {
          // Never show a stitched result that a full run would not give: compute everything instead.
          const run = getRun(runId);
          patchRun(runId, { phase: 'error', error: `Reprise impossible (${failure}) : recalcul complet lancé.`, finishedAt: Date.now() });
          const engine = await engineForRun();
          if (engine && run) void launch(engine, merge.request, run.label, { purpose: 'backtest', configKeys: merge.configKeys });
          return;
        }
        const shown = merged;
        await present(runId, shown, shown.summary, JSON.stringify(shown.summary), async (i) => JSON.stringify(await shown.fetchDetail(i)));
      }

      /** Shows a finished result where it belongs and stores it in the history. */
      async function present(runId: string, result: LoadedResult, summary: ResultSummary, summaryText: string, detailText: (i: number) => Promise<string>) {
        runResults.set(runId, result);
        patchRun(runId, { phase: 'done', finishedAt: Date.now() });
        const run = getRun(runId);
        if (!run) return;
        if (run.purpose === 'allocations') {
          // Asked for from the Allocations page: fill its own slot, whatever page is open.
          presentResult(run, result, false);
        } else {
          // Never yank the user away from a result they are reading: finished runs wait in the panel.
          const view = get().view;
          if (view === 'build' || view === 'history') presentResult(run, result, true);
          else if (!get().result) presentResult(run, result, false);
        }
        const request = run.merge?.request ?? run.request ?? { portfolios: get().portfolios.map(toEngineConfig), options: get().options };
        saveRun({
          label: run.label,
          engine: run.engineKind ?? 'local',
          request,
          requestKey: run.requestKey ?? null,
          engineCode: run.engineCode ?? null,
          kind: run.purpose ?? 'backtest',
          configKeys: run.merge?.configKeys ?? run.configKeys ?? [],
          summary,
          summaryText,
          detailText,
        })
          .then((id) => {
            patchRun(runId, { savedId: id });
            patchSlotOf(result, { runId: id });
          })
          .catch((e: Error) => patchSlotOf(result, { saveError: e.message }));
      }

      function poll(client: EngineClient, runId: string, jobId: string, delay: number) {
        stopPolling(runId);
        pollTimers.set(runId, setTimeout(async () => {
          pollTimers.delete(runId);
          const run = getRun(runId);
          if (!run || run.job?.id !== jobId || !['queued', 'running', 'submitting'].includes(run.phase)) return;
          try {
            const job = await client.job(jobId);
            if (getRun(runId)?.phase === 'cancelled') return;
            if (job.status === 'done') {
              await finish(client, runId, job);
              return;
            }
            if (job.status === 'error' || job.status === 'cancelled') {
              patchRun(runId, { job, phase: job.status as RunPhase, error: job.error, finishedAt: Date.now() });
              return;
            }
            patchRun(runId, { job, phase: job.status as RunPhase, error: null });
            const elapsed = Date.now() - (run.startedAt ?? Date.now());
            poll(client, runId, jobId, elapsed < 15_000 ? 350 : elapsed < 120_000 ? 800 : 1500);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if ((e as { status?: number }).status === 404) {
              patchRun(runId, { phase: 'error', error: 'Le moteur a redémarré : ce job n’existe plus.', finishedAt: Date.now() });
              return;
            }
            patchRun(runId, { error: msg });
            poll(client, runId, jobId, 3000);
          }
        }, delay));
      }

      return {
        portfolios: [defaultPortfolio('60/40 SPY TLT')],
        selectedId: null,
        options: DEFAULT_OPTIONS,
        view: 'build',
        runs: [],
        launchError: null,
        result: null,
        resultRunId: null,
        resultLabel: '',
        resultSource: 'run',
        saveError: null,
        alloc: null,
        reuseOffer: null,
        reuseNotice: null,

        select: (id) => set({ selectedId: id }),
        setView: (view) => set({ view }),

        addPortfolio: () => {
          const taken = new Set(get().portfolios.map((p) => p.name));
          const p = defaultPortfolio(uniqueName('Nouveau portfolio', taken));
          set((s) => ({ portfolios: [...s.portfolios, p], selectedId: p._id }));
        },

        duplicatePortfolio: (id) => {
          const src = get().portfolios.find((p) => p._id === id);
          if (!src) return;
          const taken = new Set(get().portfolios.map((p) => p.name));
          const copy: EditablePortfolio = {
            ...structuredClone(src),
            _id: newId(),
            name: uniqueName(`${src.name} (copie)`, taken),
          };
          const idx = get().portfolios.findIndex((p) => p._id === id);
          const next = [...get().portfolios];
          next.splice(idx + 1, 0, copy);
          set({ portfolios: next, selectedId: copy._id });
        },

        removePortfolio: (id) => {
          const list = get().portfolios;
          const idx = list.findIndex((p) => p._id === id);
          const next = list.filter((p) => p._id !== id);
          set({
            portfolios: next,
            selectedId: get().selectedId === id ? (next[Math.max(0, idx - 1)]?._id ?? null) : get().selectedId,
          });
        },

        movePortfolio: (id, delta) => {
          const list = [...get().portfolios];
          const i = list.findIndex((p) => p._id === id);
          const j = i + delta;
          if (i < 0 || j < 0 || j >= list.length) return;
          [list[i], list[j]] = [list[j], list[i]];
          set({ portfolios: list });
        },

        updatePortfolio: (id, patch) => patchPortfolio(id, (p) => ({ ...p, ...patch })),

        resetPortfolio: (id) => patchPortfolio(id, (p) => ({ ...defaultPortfolio(p.name), _id: p._id })),

        renamePortfolio: (id, name) => {
          const old = get().portfolios.find((p) => p._id === id)?.name;
          set((s) => ({
            portfolios: s.portfolios.map((p) => {
              if (p._id === id) return { ...p, name };
              const f = p.fusion_portfolio;
              if (!old || !f?.enabled || !f.selected_portfolios.includes(old)) return p;
              const allocations = { ...f.allocations };
              if (old in allocations) {
                allocations[name] = allocations[old];
                delete allocations[old];
              }
              return {
                ...p,
                fusion_portfolio: { ...f, selected_portfolios: f.selected_portfolios.map((n) => (n === old ? name : n)), allocations },
              };
            }),
          }));
        },

        updateStock: (id, index, patch) =>
          patchPortfolio(id, (p) => ({ ...p, stocks: p.stocks.map((s, i) => (i === index ? { ...s, ...patch } : s)) })),

        addStocks: (id, tickers) =>
          patchPortfolio(id, (p) => {
            const have = new Set(p.stocks.map((s) => s.ticker.toUpperCase()));
            const fresh = tickers
              .map(resolveTicker)
              .filter((t) => t && !have.has(t) && (have.add(t), true))
              .map((ticker) => ({ ticker, allocation: 0, include_dividends: !isInverse(ticker), include_in_sma_filter: true }));
            return { ...p, stocks: [...p.stocks, ...fresh] };
          }),

        removeStock: (id, index) => patchPortfolio(id, (p) => ({ ...p, stocks: p.stocks.filter((_, i) => i !== index) })),

        equalizeStocks: (id) =>
          patchPortfolio(id, (p) => {
            const n = p.stocks.filter((s) => s.ticker.trim()).length;
            if (!n) return p;
            return { ...p, stocks: p.stocks.map((s) => ({ ...s, allocation: s.ticker.trim() ? 1 / n : 0 })) };
          }),

        setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),

        importJson: (text, mode) => {
          const { portfolios, options } = parseImport(text);
          if (mode === 'active') {
            const target = get().portfolios.find((p) => p._id === get().selectedId) ?? get().portfolios[0];
            if (!target || portfolios.length !== 1) throw new Error('Colle le JSON d’un seul portfolio pour mettre à jour le portfolio actif.');
            const taken = new Set(get().portfolios.filter((p) => p._id !== target._id).map((p) => p.name));
            const next = { ...portfolios[0], _id: target._id, name: uniqueName(portfolios[0].name, taken) };
            // Like Streamlit's single-portfolio paste: global settings (start_with, first rebalance,
            // auto-adjust) only come from a bulk import; the dates are the only options applied.
            const dates: Partial<RunOptions> = {};
            if (options.start_date !== undefined) dates.start_date = options.start_date;
            if (options.end_date !== undefined) dates.end_date = options.end_date;
            set((s) => ({ portfolios: s.portfolios.map((p) => (p._id === target._id ? next : p)), options: { ...s.options, ...dates } }));
            return 1;
          }
          if (mode === 'replace') {
            set((s) => ({ portfolios, selectedId: portfolios[0]?._id ?? null, options: { ...s.options, ...options } }));
          } else {
            const taken = new Set(get().portfolios.map((p) => p.name));
            const renamed = portfolios.map((p) => {
              const name = uniqueName(p.name, taken);
              taken.add(name);
              return { ...p, name };
            });
            set((s) => ({ portfolios: [...s.portfolios, ...renamed], selectedId: renamed[0]?._id ?? s.selectedId }));
          }
          return portfolios.length;
        },

        commitName: (id) => {
          const p = get().portfolios.find((x) => x._id === id);
          if (!p) return;
          const taken = new Set(get().portfolios.filter((x) => x._id !== id).map((x) => x.name));
          const name = uniqueName(p.name.trim() || 'Portfolio', taken);
          if (name !== p.name) get().renamePortfolio(id, name);
        },

        removePortfolios: (ids) => {
          const drop = new Set(ids);
          const list = get().portfolios;
          const next = list.filter((p) => !drop.has(p._id));
          const sel = get().selectedId;
          set({ portfolios: next, selectedId: sel && !drop.has(sel) ? sel : (next[0]?._id ?? null) });
        },

        syncFromFirst: (what) => {
          const [first, ...rest] = get().portfolios;
          if (!first) return 0;
          let count = 0;
          const next = rest.map((p) => {
            if (what === 'cashflow') {
              if (p.exclude_from_cashflow_sync) return p;
              if (p.initial_value === first.initial_value && p.added_amount === first.added_amount && p.added_frequency === first.added_frequency) return p;
              count++;
              return { ...p, initial_value: first.initial_value, added_amount: first.added_amount, added_frequency: first.added_frequency };
            }
            if (p.exclude_from_rebalancing_sync || p.rebalancing_frequency === first.rebalancing_frequency) return p;
            count++;
            return { ...p, rebalancing_frequency: first.rebalancing_frequency };
          });
          if (count) set({ portfolios: [first, ...next] });
          return count;
        },

        addVariants: (baseId, variants, keepBase) => {
          set((s) => {
            const kept = keepBase || s.portfolios.length <= 1 ? s.portfolios : s.portfolios.filter((p) => p._id !== baseId);
            return { portfolios: [...kept, ...variants], selectedId: variants[0]?._id ?? s.selectedId };
          });
        },

        createFusion: (name, allocations, frequency) => {
          const list = get().portfolios;
          const first = list[0];
          const taken = new Set(list.map((p) => p.name));
          const fusion: EditablePortfolio = {
            ...defaultPortfolio(uniqueName(name, taken)),
            stocks: [],
            use_momentum: false,
            momentum_windows: [],
            initial_value: first?.initial_value ?? 10000,
            added_amount: first?.added_amount ?? 1000,
            added_frequency: first?.added_frequency ?? 'Monthly',
            rebalancing_frequency: frequency,
            benchmark_ticker: first?.benchmark_ticker ?? '^GSPC',
            fusion_portfolio: { enabled: true, selected_portfolios: Object.keys(allocations), allocations },
          };
          set({ portfolios: [...list, fusion], selectedId: fusion._id });
        },

        replaceAll: (portfolios, options) =>
          set((s) => ({
            portfolios,
            selectedId: portfolios[0]?._id ?? null,
            options: options ? { ...DEFAULT_OPTIONS, ...options } : s.options,
            view: 'build',
          })),

        async startRun(onlyIds, opts) {
          const options: RunOptions = get().options;
          let selected = get().portfolios;
          if (onlyIds?.length) {
            const wanted = new Set(onlyIds);
            const needed = new Set<string>();
            for (const p of selected) {
              if (wanted.has(p._id) && p.fusion_portfolio?.enabled) p.fusion_portfolio.selected_portfolios.forEach((n) => needed.add(n));
            }
            selected = selected.filter((p) => wanted.has(p._id) || needed.has(p.name));
          }
          if (!selected.length) return null;
          // Streamlit clears per-portfolio dates unless the sidebar custom dates are set.
          const portfolios = selected.map((p) => ({
            ...toEngineConfig(p),
            start_date_user: options.start_date,
            end_date_user: options.end_date,
          }));
          const errors = validatePortfolios(portfolios);
          if (errors.length) {
            set({ launchError: `Backtest bloqué :\n• ${errors.join('\n• ')}` });
            return null;
          }
          const label = runLabel(selected.map((p) => p.name));
          const request: RunRequest = { portfolios, options };
          set({ launchError: null });
          const engine = await engineForRun();
          if (!engine) {
            set({ launchError: NO_ENGINE });
            return null;
          }
          const keys = await configKeys(request).catch(() => [] as string[]);
          const offer = opts?.force ? null : await findOffer(engine, request, keys);
          if (offer) {
            const available = offer.items.filter((i) => i.sources.length).map((i) => i.position);
            const upToDate = offer.items.every((i) => !i.sources.length || i.sources[0].end === offer.targetEnd);
            // "Toujours reprendre" stays silent only when taking the saved results changes nothing.
            const choice: ReuseChoice = autoReuse() && upToDate ? { action: 'reuse', accepted: available } : await askReuse(offer);
            if (choice.action === 'cancel') return null;
            if (choice.action === 'reuse') {
              const decision = decide(offer, choice.accepted);
              if (decision.reuse.size) {
                try {
                  return await launchWithReuse(engine, offer, decision, label, keys);
                } catch (e) {
                  set({ launchError: `Reprise impossible (${e instanceof Error ? e.message : String(e)}) : calcul complet.` });
                }
              }
            }
          }
          return launch(engine, request, label, { purpose: 'backtest', configKeys: keys });
        },

        async startAllocationRun(portfolioId, opts) {
          const all = get().portfolios;
          const target = all.find((p) => p._id === portfolioId);
          if (!target) return null;
          const members = new Set(target.fusion_portfolio?.enabled ? target.fusion_portfolio.selected_portfolios : []);
          const configs = all.filter((p) => p._id === portfolioId || members.has(p.name)).map(toEngineConfig);
          const errors = validatePortfolios(configs);
          if (errors.length) {
            set({ launchError: `Analyse bloquée :\n• ${errors.join('\n• ')}` });
            return null;
          }
          set({ launchError: null });
          const engine = await engineForRun();
          const window = allocationWindow(configs);
          if (window.start && needsCycleAnchor(configs)) {
            // The 2-week cycle is anchored on the full run's start: only the engine knows it.
            const full = allocationOptions({ start: null, days: null, reason: null });
            const plan = engine
              ? await new EngineClient(engine.url, engine.health.auth_required)
                .plan(configs.map((c) => ({ ...c, start_date_user: null, end_date_user: null })), full)
                .catch(() => null)
              : null;
            window.start = plan?.simulation.start ? alignToCycle(window.start, plan.simulation.start) : null;
          }
          const options = allocationOptions(window);
          const portfolios = configs.map((c) => ({ ...c, start_date_user: options.start_date, end_date_user: null }));
          const request: RunRequest = { portfolios, options };
          const key = await requestKey(request).catch(() => null);
          if (key && !opts?.force) {
            const row = await findReusable(key, request, engine?.health.code, true);
            const rerun = () => void get().startAllocationRun(portfolioId, { force: true });
            if (row && (await openSaved(row, 'allocations', target.name, rerun, request).catch(() => false))) return null;
          }
          if (!engine) {
            set({ launchError: NO_ENGINE });
            return null;
          }
          const keys = await configKeys(request).catch(() => [] as string[]);
          return launch(engine, request, `Allocations · ${target.name}`, { purpose: 'allocations', requestKey: key, focus: target.name, configKeys: keys });
        },

        resolveReuse(choice) {
          const resolve = reuseResolver;
          reuseResolver = null;
          set({ reuseOffer: null });
          resolve?.(choice);
        },

        dismissReuseNotice: () => set({ reuseNotice: null }),

        showAllocResult: (result, runId, label, focus = null) =>
          set((s) => ({
            alloc: { result, runId, label, source: 'history', focus, saveError: null },
            reuseNotice: s.reuseNotice?.purpose === 'allocations' ? null : s.reuseNotice,
            view: s.view === 'history' ? 'allocations' : s.view,
          })),

        async cancelRun(id) {
          const run = getRun(id);
          if (!run) return;
          stopPolling(id);
          patchRun(id, { phase: 'cancelled', finishedAt: Date.now() });
          if (run.job && run.engineUrl) {
            try {
              await new EngineClient(run.engineUrl, run.authRequired).cancel(run.job.id);
            } catch {
              /* engine gone: nothing left to cancel */
            }
          }
        },

        dismissRun(id) {
          stopPolling(id);
          runResults.delete(id);
          set((s) => ({ runs: s.runs.filter((r) => r.id !== id) }));
        },

        async openRun(id) {
          const run = getRun(id);
          if (!run) return;
          const cached = runResults.get(id);
          if (cached) {
            presentResult(run, cached, true);
            return;
          }
          if (run.savedId) {
            const saved = await loadRun(run.savedId);
            if (saved.result) {
              runResults.set(id, saved.result);
              presentResult(run, saved.result, true);
              return;
            }
          }
          if (run.job && run.engineUrl) {
            try {
              await finish(new EngineClient(run.engineUrl, run.authRequired), id, run.job);
              const loaded = runResults.get(id);
              const fresh = getRun(id);
              if (loaded && fresh) presentResult(fresh, loaded, true);
              return;
            } catch {
              /* engine result expired */
            }
          }
          patchRun(id, { error: 'Résultat introuvable (moteur redémarré et run non sauvegardé).' });
        },

        resumeRun() {
          for (const run of get().runs) {
            if (!run.job || !run.engineUrl || !isActive(run)) continue;
            if (run.phase === 'fetching') patchRun(run.id, { phase: 'running' });
            poll(new EngineClient(run.engineUrl, run.authRequired), run.id, run.job.id, 100);
          }
        },

        showResult: (result, runId, label) =>
          set((s) => ({
            result,
            resultRunId: runId,
            resultLabel: label,
            resultSource: runId ? 'history' : 'file',
            saveError: null,
            reuseNotice: s.reuseNotice?.purpose === 'backtest' ? null : s.reuseNotice,
            view: resultView(s.view),
          })),
      };
    },
    {
      name: 'backtester-v1',
      storage: createJSONStorage(clientStorage),
      version: 2,
      partialize: (s) => ({ portfolios: s.portfolios, selectedId: s.selectedId, options: s.options, runs: s.runs, view: s.view }),
      migrate: (persisted, version) => {
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) {
          const old = state.run as Partial<RunState> | undefined;
          delete state.run;
          state.runs = old?.job
            ? [{
              id: newId(), finishedAt: null, portfolioCount: old.request?.portfolios.length ?? 0, savedId: null,
              phase: 'idle', job: null, engineUrl: null, engineKind: null, authRequired: false, error: null,
              startedAt: null, label: '', request: null, ...old,
            }]
            : [];
        }
        return state as unknown as BacktestState;
      },
    },
  ),
);
