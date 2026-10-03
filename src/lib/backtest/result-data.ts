import type {
  LegacyPayload,
  PortfolioDetail,
  PortfolioSummary,
  PortfolioSummaryOk,
  ResultBundle,
  ResultSummary,
  SeriesRef,
} from '@/lib/engine/types';

/** Loads the detail chunk of one portfolio (engine job, Supabase folder or in-memory bundle). */
export type DetailFetcher = (index: number) => Promise<PortfolioDetail | null>;

export interface LoadedResult {
  /** Stable key for caches (job id, run id or file name). */
  key: string;
  summary: ResultSummary;
  fetchDetail: DetailFetcher;
  /** Some portfolio details were not stored (light account): they are shown after a re-run. */
  detailsPartial?: boolean;
}

export function okSummaries(summary: ResultSummary): PortfolioSummaryOk[] {
  return summary.portfolios.filter((p): p is PortfolioSummaryOk => p.ok);
}

/** Dates of a series stored on the shared axis. */
export function refDates(summary: ResultSummary, ref: { offset?: number; dates?: string[] }, length: number): string[] {
  if (ref.dates) return ref.dates;
  const start = ref.offset ?? 0;
  return summary.dates.slice(start, start + length);
}

export function portfolioDates(summary: ResultSummary, p: PortfolioSummaryOk): string[] {
  return refDates(summary, p.series, p.series.with_additions.length);
}

export function noAdditions(p: PortfolioSummaryOk): (number | null)[] {
  return p.series.no_additions ?? p.series.with_additions;
}

export function benchmarkSeries(summary: ResultSummary, ticker: string): { dates: string[]; values: (number | null)[] } | null {
  const b: SeriesRef | undefined = summary.benchmarks[ticker];
  if (!b) return null;
  return { dates: refDates(summary, b, b.values.length), values: b.values };
}

/** Format 1 payload (single JSON) -> bundle with explicit dates. */
export function upgradeLegacy(p: LegacyPayload): ResultBundle {
  const portfolios: PortfolioSummary[] = [];
  const details: (PortfolioDetail | null)[] = [];
  for (const r of p.portfolios) {
    if (!r.ok) {
      portfolios.push({ index: r.index, name: r.name, ok: false, error: r.error });
      details.push(null);
      continue;
    }
    portfolios.push({
      index: r.index,
      name: r.name,
      fusion: !!r.config?.fusion_portfolio?.enabled,
      ok: true,
      config: r.config,
      series: { dates: r.series.dates, with_additions: r.series.with_additions, no_additions: r.series.no_additions },
      stats: r.stats,
      stats_display: r.stats_display,
      today_weights: r.today_weights,
      current_alloc: r.current_alloc,
      last_rebalance_date: r.last_rebalance_date,
    });
    details.push({ format: 2, index: r.index, name: r.name, allocations: r.allocations });
  }
  const benchmarks: Record<string, SeriesRef> = {};
  for (const [t, b] of Object.entries(p.benchmarks ?? {})) benchmarks[t] = { dates: b.dates, values: b.values };
  return {
    format: 2,
    summary: {
      format: 2,
      engine_version: p.engine_version,
      options: p.options,
      duration_s: p.duration_s,
      simulation: p.simulation,
      dates: [],
      invalid_tickers: p.invalid_tickers ?? [],
      warnings: p.warnings ?? [],
      portfolios,
      benchmarks,
      market: {},
    },
    details,
  };
}

/** Accepts a bundle, a bare format-2 summary or a format-1 payload. */
export function toBundle(obj: unknown): ResultBundle {
  const o = obj as Record<string, unknown> | null;
  if (o && o.format === 2 && o.summary && Array.isArray((o.summary as ResultSummary).portfolios)) return o as unknown as ResultBundle;
  if (o && o.format === 2 && Array.isArray(o.portfolios)) {
    const summary = o as unknown as ResultSummary;
    return { format: 2, summary, details: summary.portfolios.map(() => null) };
  }
  if (o && Array.isArray(o.portfolios) && o.simulation) return upgradeLegacy(o as unknown as LegacyPayload);
  throw new Error('Ce fichier n’est pas un résultat de backtest.');
}

export function bundleResult(key: string, bundle: ResultBundle): LoadedResult {
  const byIndex = new Map<number, PortfolioDetail>();
  bundle.details.forEach((d, k) => {
    if (d) byIndex.set(d.index ?? bundle.summary.portfolios[k]?.index ?? k, d);
  });
  return { key, summary: bundle.summary, fetchDetail: async (i) => byIndex.get(i) ?? null };
}

/** Small LRU of detail promises shared by every panel. */
class DetailCache {
  private map = new Map<string, Promise<PortfolioDetail | null>>();

  constructor(private readonly max = 16) {}

  get(result: LoadedResult, index: number): Promise<PortfolioDetail | null> {
    const k = `${result.key}:${index}`;
    const hit = this.map.get(k);
    if (hit) {
      this.map.delete(k);
      this.map.set(k, hit);
      return hit;
    }
    const p = result.fetchDetail(index).catch((e) => {
      this.map.delete(k);
      throw e;
    });
    this.map.set(k, p);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return p;
  }
}

export const detailCache = new DetailCache();
