'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { EngineClient, type EngineKind } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import type { EngineJob, PortfolioConfig, ResultSummary, RunOptions, StockConfig } from '@/lib/engine/types';
import { loadRun, saveRun } from './history';
import type { LoadedResult } from './result-data';
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

/** Opening a result keeps the user on the Allocations page (it reads the same result). */
const resultView = (current: BacktestView): BacktestView => (current === 'allocations' ? 'allocations' : 'results');

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

  select: (id: string) => void;
  setView: (v: BacktestView) => void;
  addPortfolio: () => void;
  duplicatePortfolio: (id: string) => void;
  removePortfolio: (id: string) => void;
  movePortfolio: (id: string, delta: number) => void;
  updatePortfolio: (id: string, patch: Partial<EditablePortfolio>) => void;
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
  /** Resolves with the run id once the job is submitted (null when nothing was launched). */
  startRun: (onlyIds?: string[]) => Promise<string | null>;
  cancelRun: (id: string) => Promise<void>;
  dismissRun: (id: string) => void;
  openRun: (id: string) => Promise<void>;
  resumeRun: () => void;
  showResult: (result: LoadedResult, runId: string | null, label: string) => void;
}

const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Finished results kept in memory (not persisted) so any finished run can be reopened instantly. */
const runResults = new Map<string, LoadedResult>();

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

      function presentResult(run: RunState, result: LoadedResult) {
        set({
          result,
          resultRunId: run.savedId,
          resultLabel: run.label,
          resultSource: 'run',
          view: resultView(get().view),
          saveError: null,
        });
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
              const savedId = getRun(runId)?.savedId ?? (get().result === result ? get().resultRunId : null);
              if (!savedId) throw e;
              const saved = await loadRun(savedId);
              return saved.result ? saved.result.fetchDetail(i) : null;
            }
          },
        };
        runResults.set(runId, result);
        patchRun(runId, { phase: 'done', finishedAt: Date.now() });
        const run = getRun(runId);
        if (!run) return;
        // Never yank the user away from a result they are reading: finished runs wait in the panel.
        if ((get().view !== 'results' && get().view !== 'allocations') || !get().result) presentResult(run, result);
        const request = run.request ?? { portfolios: get().portfolios.map(toEngineConfig), options: get().options };
        saveRun({
          label: run.label,
          engine: run.engineKind ?? 'local',
          request,
          summary,
          summaryText,
          detailText: (i) => client.portfolioText(jobId, i),
        })
          .then((id) => {
            patchRun(runId, { savedId: id });
            if (get().result === result) set({ resultRunId: id });
          })
          .catch((e: Error) => { if (get().result === result) set({ saveError: e.message }); });
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

        async startRun(onlyIds) {
          const engineState = useEngineStore.getState();
          let engine = engineState.engine;
          if (!engine) engine = await engineState.detect();
          if (!engine) {
            set({ launchError: 'Aucun moteur disponible. Lance le moteur sur ton PC ou configure le moteur en ligne.' });
            return null;
          }
          const { options } = get();
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
          const run: RunState = {
            id: newId(), phase: 'submitting', job: null, engineUrl: engine.url, engineKind: engine.kind,
            authRequired: engine.health.auth_required, error: null, startedAt: Date.now(), finishedAt: null, label,
            portfolioCount: portfolios.length, savedId: null, request: { portfolios, options },
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
            const job = await client.submit(portfolios, options, label);
            patchRun(run.id, { job, phase: job.status as RunPhase });
            poll(client, run.id, job.id, 250);
          } catch (e) {
            patchRun(run.id, { phase: 'error', error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() });
          }
          return run.id;
        },

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
            presentResult(run, cached);
            return;
          }
          if (run.savedId) {
            const saved = await loadRun(run.savedId);
            if (saved.result) {
              runResults.set(id, saved.result);
              presentResult(run, saved.result);
              return;
            }
          }
          if (run.job && run.engineUrl) {
            try {
              await finish(new EngineClient(run.engineUrl, run.authRequired), id, run.job);
              const loaded = runResults.get(id);
              const fresh = getRun(id);
              if (loaded && fresh) presentResult(fresh, loaded);
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
          set({
            result,
            resultRunId: runId,
            resultLabel: label,
            resultSource: runId ? 'history' : 'file',
            saveError: null,
            view: resultView(get().view),
          }),
      };
    },
    {
      name: 'backtester-v1',
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
