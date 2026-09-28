import type { BacktestRunRow } from './history';
import type { LoadedResult } from './result-data';
import { barFinalAt, requestHasCrypto, type RunRequest } from './run-key';
import type { PortfolioDetail, PortfolioSummary, ResultSummary, RunOptions, RunPlan } from '@/lib/engine/types';

/** A saved run already holding this exact portfolio result (only the end date may differ). */
export interface ReuseSource {
  row: BacktestRunRow;
  /** Detail chunk index of the portfolio inside that run. */
  index: number;
  end: string;
}

export interface PortfolioReuse {
  position: number;
  name: string;
  /** Latest end first. */
  sources: ReuseSource[];
}

export interface ReuseOffer {
  request: RunRequest;
  plan: RunPlan;
  items: PortfolioReuse[];
  /** Where a fresh run would end today. */
  targetEnd: string;
}

export interface ReuseDecision {
  end: string;
  reuse: Map<number, ReuseSource>;
  compute: number[];
}

/** Stored portfolio results matching the plan's identities, usable as they are. */
export function buildOffer(request: RunRequest, plan: RunPlan, rows: BacktestRunRow[]): ReuseOffer | null {
  const targetEnd = plan.simulation.end;
  if (!targetEnd || plan.portfolios.length !== request.portfolios.length) return null;
  const crypto = requestHasCrypto(request);
  const items = request.portfolios.map((p, position): PortfolioReuse => {
    const key = plan.portfolios[position].history_key;
    const sources: ReuseSource[] = [];
    for (const row of rows) {
      const end = row.simulation_end;
      // Longer than wanted: cutting the curve would not give the same statistics.
      if (!end || end > targetEnd) continue;
      // Prices of the last day still moving at the time: not reproducible.
      if (!barFinalAt(new Date(row.created_at), end, crypto)) continue;
      const entry = row.summary?.find((s) => s.ok && s.key === key && s.index != null);
      if (entry) sources.push({ row, index: entry.index!, end });
    }
    sources.sort((a, b) => (a.end !== b.end ? (a.end < b.end ? 1 : -1) : b.row.created_at.localeCompare(a.row.created_at)));
    return { position, name: p.name, sources };
  });
  return items.some((i) => i.sources.length) ? { request, plan, items, targetEnd } : null;
}

/** End = earliest end among the accepted results; fusions recomputed pull their members along. */
export function decide(offer: ReuseOffer, accepted: Iterable<number>): ReuseDecision {
  const configs = offer.request.portfolios;
  let chosen = [...accepted].filter((pos) => offer.items[pos]?.sources.length);
  // Dropping a result (no copy at the common end, member of a recomputed fusion) can push the
  // end later: repeat until the reused set is stable.
  for (;;) {
    let end = offer.targetEnd;
    for (const pos of chosen) end = minDay(end, offer.items[pos].sources[0].end);
    const reuse = new Map<number, ReuseSource>();
    for (const pos of chosen) {
      const source = offer.items[pos].sources.find((s) => s.end === end);
      if (source) reuse.set(pos, source);
    }
    for (let changed = true; changed; ) {
      changed = false;
      configs.forEach((cfg, pos) => {
        const f = cfg.fusion_portfolio;
        if (reuse.has(pos) || !f?.enabled) return;
        configs.forEach((m, mpos) => {
          const member = !m.fusion_portfolio?.enabled && (!f.selected_portfolios.length || f.selected_portfolios.includes(m.name));
          if (member && reuse.delete(mpos)) changed = true;
        });
      });
    }
    if (reuse.size === chosen.length) {
      const compute = configs.map((_, pos) => pos).filter((pos) => !reuse.has(pos));
      return { end: reuse.size ? end : offer.targetEnd, reuse, compute };
    }
    chosen = [...reuse.keys()];
  }
}

export function minDay(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Calendar days between two YYYY-MM-DD dates. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);
}

export interface MergePart {
  position: number;
  result: LoadedResult;
  /** Chunk index of the portfolio inside `result`. */
  index: number;
  historyKey: string | null;
}

/** One result made of portfolios coming from several runs sharing the same date axis. */
export function mergeResults(key: string, options: RunOptions, parts: MergePart[]): LoadedResult {
  if (!parts.length) throw new Error('Rien à combiner.');
  const sorted = [...parts].sort((a, b) => a.position - b.position);
  const base = sorted[0].result.summary;
  for (const p of sorted) {
    const d = p.result.summary.dates;
    if (d.length !== base.dates.length || d[0] !== base.dates[0] || d[d.length - 1] !== base.dates[base.dates.length - 1]) {
      throw new Error('Les résultats repris n’ont pas le même axe de dates : recalcul complet nécessaire.');
    }
  }
  const summaries = [...new Set(sorted.map((p) => p.result.summary))];
  const portfolios = sorted.map((p): PortfolioSummary => {
    const piece = p.result.summary.portfolios.find((s) => s.index === p.index);
    if (!piece) throw new Error(`Portfolio introuvable dans un résultat repris (#${p.index}).`);
    return piece.ok ? { ...piece, index: p.position, history_key: p.historyKey ?? piece.history_key } : { ...piece, index: p.position };
  });
  const union = <T,>(pick: (s: ResultSummary) => Record<string, T> | undefined) =>
    Object.assign({}, ...summaries.map((s) => pick(s) ?? {})) as Record<string, T>;
  const list = (pick: (s: ResultSummary) => string[] | undefined) => [...new Set(summaries.flatMap((s) => pick(s) ?? []))];
  const summary: ResultSummary = {
    ...base,
    options,
    duration_s: summaries.reduce((t, s) => t + (s.duration_s || 0), 0),
    portfolios,
    benchmarks: union((s) => s.benchmarks),
    benchmark_returns: union((s) => s.benchmark_returns as Record<string, unknown> | undefined),
    invalid_tickers: list((s) => s.invalid_tickers),
    warnings: list((s) => s.warnings).slice(0, 50),
  };
  const byPosition = new Map(sorted.map((p) => [p.position, p]));
  return {
    key,
    summary,
    fetchDetail: async (i: number) => {
      const p = byPosition.get(i);
      if (!p) return null;
      const detail: PortfolioDetail | null = await p.result.fetchDetail(p.index);
      return detail ? { ...detail, index: i } : null;
    },
  };
}
