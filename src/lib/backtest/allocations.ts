'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { EngineClient } from '@/lib/engine/client';
import type { BenchmarkRow, FundamentalsReport, PortfolioConfig, PortfolioSummaryOk, TimerInfo } from '@/lib/engine/types';
import { RESULTS_BUCKET } from './history';
import { noAdditions, portfolioDates, type LoadedResult } from './result-data';

/** Allocations analysis of one portfolio of one run: inputs + every output of the page. */
export interface AllocationAnalysis {
  version: 1;
  created_at: string;
  run: { id: string | null; label: string; key: string };
  portfolio: {
    index: number;
    name: string;
    benchmark_ticker: string | null;
    config: PortfolioConfig;
    stats: Record<string, string>;
    weights: Record<string, number>;
    portfolio_value: number;
    prices: Record<string, number | null>;
    timer: TimerInfo | null;
  };
  fundamentals: FundamentalsReport | null;
  benchmarks: BenchmarkRow[] | null;
  errors: { fundamentals?: string; benchmarks?: string };
}

const BENCH_WINDOW_DAYS = 400;

function inputsOf(result: LoadedResult, runId: string | null, label: string, p: PortfolioSummaryOk): Omit<AllocationAnalysis, 'fundamentals' | 'benchmarks' | 'errors'> {
  const today = p.today;
  const weights = today?.weights ?? p.today_weights ?? {};
  const value = today?.portfolio_value ?? p.stats['Final Value (with)'] ?? p.config.initial_value ?? 10000;
  return {
    version: 1,
    created_at: new Date().toISOString(),
    run: { id: runId, label, key: result.key },
    portfolio: {
      index: p.index,
      name: p.name,
      benchmark_ticker: p.config.benchmark_ticker || null,
      config: p.config,
      stats: p.stats_display,
      weights,
      portfolio_value: Number(value) || 10000,
      prices: today?.prices ?? {},
      timer: p.timer ?? null,
    },
  };
}

/** Last ~400 days of the no-additions curve: enough for 1Y returns and 365-day volatility / beta. */
function recentSeries(result: LoadedResult, p: PortfolioSummaryOk): { dates: string[]; values: (number | null)[] } | null {
  const dates = portfolioDates(result.summary, p);
  const values = noAdditions(p);
  if (!dates.length) return null;
  const last = new Date(dates[dates.length - 1]).getTime();
  let k = dates.length - 1;
  while (k > 0 && last - new Date(dates[k - 1]).getTime() <= BENCH_WINDOW_DAYS * 86_400_000) k--;
  return { dates: dates.slice(k), values: values.slice(k) };
}

export async function computeAnalysis(
  client: EngineClient,
  result: LoadedResult,
  runId: string | null,
  label: string,
  p: PortfolioSummaryOk,
): Promise<AllocationAnalysis> {
  const base = inputsOf(result, runId, label, p);
  const { weights, portfolio_value, prices, benchmark_ticker } = base.portfolio;
  const errors: AllocationAnalysis['errors'] = {};
  const fundamentals = await client.allocationFundamentals(weights, portfolio_value, prices).catch((e: Error) => {
    errors.fundamentals = e.message;
    return null;
  });
  const benchmarks = await client
    .allocationBenchmarks({
      portfolio: recentSeries(result, p),
      benchmark_ticker,
      portfolio_pe: fundamentals?.weighted.pe ?? null,
    })
    .catch((e: Error) => {
      errors.benchmarks = e.message;
      return null;
    });
  return { ...base, fundamentals, benchmarks, errors };
}

// ---- Supabase: stored next to the run, backtest-results/<uid>/<runId>/allocations/<index>.json.gz

async function analysisPath(runId: string, index: number): Promise<string | null> {
  const { data: { user } } = await createClient().auth.getUser();
  return user ? `${user.id}/${runId}/allocations/${index}.json.gz` : null;
}

export async function saveAnalysis(a: AllocationAnalysis): Promise<boolean> {
  if (!a.run.id) return false;
  const path = await analysisPath(a.run.id, a.portfolio.index);
  if (!path) return false;
  const stream = new Blob([JSON.stringify(a)]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(stream).blob();
  const { error } = await createClient().storage.from(RESULTS_BUCKET).upload(path, blob, { contentType: 'application/gzip', upsert: true });
  if (error) throw new Error(error.message);
  return true;
}

export async function loadAnalysis(runId: string, index: number): Promise<AllocationAnalysis | null> {
  const path = await analysisPath(runId, index);
  if (!path) return null;
  const { data, error } = await createClient().storage.from(RESULTS_BUCKET).download(path);
  if (error || !data) return null;
  const text = await new Response(data.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  const parsed = JSON.parse(text) as AllocationAnalysis;
  return parsed?.version === 1 ? parsed : null;
}

// ---- AI-ready export

export const FIELD_UNITS: Record<string, string> = {
  price: 'USD', value: 'USD', alloc_pct: '%', pct_of_portfolio: '%', market_cap_b: 'USD billions',
  enterprise_value_b: 'USD billions', fcf_b: 'USD billions', revenue_b: 'USD billions', earnings_b: 'USD billions',
  total_debt_b: 'USD billions', net_debt_b: 'USD billions', working_capital_b: 'USD billions',
  shares_outstanding_m: 'millions', float_shares_m: 'millions', fcf_yield: '%', roe: '%', roa: '%', roic: '%',
  revenue_growth: '%', earnings_growth: '%', eps_growth: '%', dividend_yield: '%', payout_ratio: '%',
  dividend_growth_5y: '% (5-year average dividend yield)', profit_margin: '%', operating_margin: '%', gross_margin: '%',
  dividend_rate: 'USD per share per year', book_value: 'USD per share', cash_per_share: 'USD per share',
  revenue_per_share: 'USD per share', target_price: 'USD', target_high: 'USD', target_low: 'USD',
};

/** Single self-describing document: parameters, holdings, fundamentals, aggregates and benchmarks. */
export function aiContext(a: AllocationAnalysis) {
  return {
    kind: 'momentum-backtester/allocations-analysis',
    version: a.version,
    generated_at: a.created_at,
    notes: [
      'weights are fractions (0-1); alloc_pct and pct_of_portfolio are percents.',
      'Weighted metrics use % of portfolio as weights and skip P/E or PEG outside (0, 1000], beta outside [-5, 5] and negative ratios.',
      'Benchmark returns are price-return snapshots over calendar lookbacks; volatility is annualized over the last 365 days.',
      'The PORTFOLIO benchmark row uses the backtest curve without additions.',
    ],
    units: FIELD_UNITS,
    run: a.run,
    portfolio: a.portfolio,
    fundamentals: a.fundamentals,
    benchmarks: a.benchmarks,
    errors: a.errors,
  };
}

export function downloadJson(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- hook

export type AnalysisSource = 'fresh' | 'saved' | 'memory';

export interface AnalysisState {
  analysis: AllocationAnalysis | null;
  source: AnalysisSource | null;
  loading: boolean;
  error: string | null;
  saved: 'idle' | 'saving' | 'ok' | 'error';
  refresh: () => void;
}

const memory = new Map<string, AllocationAnalysis>();
const sameDay = (iso: string) => iso.slice(0, 10) === new Date().toISOString().slice(0, 10);

/**
 * Today's analysis of a portfolio: memory, then the copy saved in Supabase (same day), then the engine
 * (fundamentals cached 24 h there). Fresh analyses of saved runs are stored back in Supabase.
 */
export function useAllocationAnalysis(
  client: EngineClient | null,
  result: LoadedResult | null,
  runId: string | null,
  label: string,
  p: PortfolioSummaryOk | null,
): AnalysisState {
  const [state, setState] = useState<Omit<AnalysisState, 'refresh'>>({ analysis: null, source: null, loading: false, error: null, saved: 'idle' });
  const [nonce, setNonce] = useState(0);
  const forced = useRef(false);
  const key = result && p ? `${result.key}:${p.index}` : null;

  useEffect(() => {
    if (!result || !p || !key) {
      setState({ analysis: null, source: null, loading: false, error: null, saved: 'idle' });
      return;
    }
    let alive = true;
    const force = forced.current;
    forced.current = false;
    const hit = memory.get(key);
    if (hit && !force && sameDay(hit.created_at)) {
      if (!runId || hit.run.id === runId) {
        setState({ analysis: hit, source: 'memory', loading: false, error: null, saved: hit.run.id ? 'ok' : 'idle' });
        return;
      }
      // The run got its history id after the analysis was computed: store it now.
      const withId = { ...hit, run: { ...hit.run, id: runId } };
      memory.set(key, withId);
      setState({ analysis: withId, source: 'memory', loading: false, error: null, saved: 'saving' });
      saveAnalysis(withId).then(
        () => alive && setState((s) => ({ ...s, saved: 'ok' })),
        () => alive && setState((s) => ({ ...s, saved: 'error' })),
      );
      return () => {
        alive = false;
      };
    }
    setState((s) => ({ ...s, analysis: s.analysis?.portfolio.index === p.index && s.analysis.run.key === result.key ? s.analysis : null, loading: true, error: null }));

    (async () => {
      if (runId && !force) {
        const stored = await loadAnalysis(runId, p.index).catch(() => null);
        if (!alive) return;
        if (stored && (sameDay(stored.created_at) || !client)) {
          memory.set(key, stored);
          setState({ analysis: stored, source: 'saved', loading: false, error: null, saved: 'ok' });
          return;
        }
      }
      if (!client) {
        setState((s) => ({ ...s, loading: false, error: 'Moteur hors ligne : lance le moteur pour charger les fondamentaux.' }));
        return;
      }
      const fresh = await computeAnalysis(client, result, runId, label, p);
      if (!alive) return;
      memory.set(key, fresh);
      const failed = !fresh.fundamentals && !fresh.benchmarks;
      setState({
        analysis: fresh,
        source: 'fresh',
        loading: false,
        error: failed ? fresh.errors.fundamentals ?? fresh.errors.benchmarks ?? 'Analyse indisponible.' : null,
        saved: runId && !failed ? 'saving' : 'idle',
      });
      if (!runId || failed) return;
      saveAnalysis(fresh).then(
        () => alive && setState((s) => ({ ...s, saved: 'ok' })),
        () => alive && setState((s) => ({ ...s, saved: 'error' })),
      );
    })().catch((e: unknown) => {
      if (alive) setState((s) => ({ ...s, loading: false, error: e instanceof Error ? e.message : String(e) }));
    });
    return () => {
      alive = false;
    };
    // The portfolio object is stable per result; `client` joining later (engine detected) retriggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, runId, client, nonce]);

  const refresh = useCallback(() => {
    forced.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { ...state, refresh };
}
