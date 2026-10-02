import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import type { EnginePrefs } from './prefs';
import { normalizeUrl } from './prefs';
import type {
  BenchmarkRow,
  ReturnsRow,
  EngineHealth,
  EngineJob,
  FundamentalsReport,
  PortfolioConfig,
  PortfolioDetail,
  RunOptions,
  RunPlan,
} from './types';

export type EngineKind = 'local' | 'cloud';

export interface ResolvedEngine {
  kind: EngineKind;
  url: string;
  health: EngineHealth;
}

export class EngineError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const LOCAL_PROBE_MS = 700;
const CLOUD_PROBE_MS = 6000;

export async function probeEngine(url: string, timeoutMs: number): Promise<EngineHealth | null> {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as EngineHealth;
    return body?.engine === 'momentum-backtest' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Picks the engine according to the preference: auto = this PC first, then cloud. */
export async function resolveEngine(prefs: EnginePrefs): Promise<ResolvedEngine | null> {
  const localUrl = normalizeUrl(prefs.localUrl).replace(/^https:\/\/(127\.0\.0\.1|localhost)/, 'http://$1');
  const cloudUrl = normalizeUrl(prefs.cloudUrl);
  if (prefs.mode !== 'cloud') {
    const h = await probeEngine(localUrl, LOCAL_PROBE_MS);
    if (h) return { kind: 'local', url: localUrl, health: h };
    if (prefs.mode === 'local') return null;
  }
  if (cloudUrl) {
    const h = await probeEngine(cloudUrl, CLOUD_PROBE_MS);
    if (h) return { kind: 'cloud', url: cloudUrl, health: h };
  }
  return null;
}

async function accessToken(): Promise<string | null> {
  if (isGuest()) return null;
  const { data } = await createClient().auth.getSession();
  return data.session?.access_token ?? null;
}

export class EngineClient {
  constructor(readonly url: string, readonly authRequired: boolean) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return JSON.parse(await this.text(path, init)) as T;
  }

  /** Raw JSON text (the browser already undid the gzip transport encoding). */
  async text(path: string, init: RequestInit = {}): Promise<string> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const token = await accessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, { ...init, headers, cache: 'no-store' });
    } catch {
      throw new EngineError('Moteur injoignable. Est-il toujours lancé ?');
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body?.detail === 'string' ? body.detail : JSON.stringify(body?.detail ?? body);
      } catch {
        /* not json */
      }
      if (res.status === 401 && isGuest()) {
        detail = 'Le moteur de calcul est réservé aux comptes pour l’instant : crée un compte gratuit pour lancer des backtests.';
      }
      throw new EngineError(detail || `HTTP ${res.status}`, res.status);
    }
    return res.text();
  }

  submit(portfolios: PortfolioConfig[], options: Partial<RunOptions>, label?: string): Promise<EngineJob> {
    return this.request('/jobs', { method: 'POST', body: JSON.stringify({ portfolios, options, label }) });
  }

  /** Simulation range + per-portfolio history keys, without simulating. */
  plan(portfolios: PortfolioConfig[], options: Partial<RunOptions>): Promise<RunPlan> {
    return this.request('/plan', { method: 'POST', body: JSON.stringify({ portfolios, options }) });
  }

  job(id: string): Promise<EngineJob> {
    return this.request(`/jobs/${id}`);
  }

  jobs(): Promise<EngineJob[]> {
    return this.request('/jobs');
  }

  cancel(id: string): Promise<EngineJob> {
    return this.request(`/jobs/${id}`, { method: 'DELETE' });
  }

  summaryText(id: string): Promise<string> {
    return this.text(`/jobs/${id}/summary`);
  }

  portfolioText(id: string, index: number): Promise<string> {
    return this.text(`/jobs/${id}/portfolio/${index}`);
  }

  async portfolio(id: string, index: number): Promise<PortfolioDetail> {
    return JSON.parse(await this.portfolioText(id, index)) as PortfolioDetail;
  }

  async searchTickers(q: string): Promise<{ symbol: string; name: string; exchange: string; type: string }[]> {
    const r = await this.request<{ quotes: { symbol: string; name: string; exchange: string; type: string }[] }>(
      `/tickers/search?q=${encodeURIComponent(q)}`,
    );
    return r.quotes;
  }

  async peRatios(tickers: string[]): Promise<Record<string, number | null>> {
    const r = await this.request<{ pe: Record<string, number | null> }>('/fundamentals/pe', {
      method: 'POST',
      body: JSON.stringify({ tickers }),
    });
    return r.pe;
  }

  allocationFundamentals(
    weights: Record<string, number>,
    portfolioValue: number,
    prices: Record<string, number | null>,
  ): Promise<FundamentalsReport> {
    return this.request('/allocations/fundamentals', {
      method: 'POST',
      body: JSON.stringify({ weights, portfolio_value: portfolioValue, prices }),
    });
  }

  async allocationBenchmarks(body: {
    portfolio: { dates: string[]; values: (number | null)[] } | null;
    benchmark_ticker: string | null;
    portfolio_pe: number | null;
  }): Promise<BenchmarkRow[]> {
    const r = await this.request<{ rows: BenchmarkRow[] }>('/allocations/benchmarks', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return r.rows;
  }

  async allocationReturns(body: {
    weights: Record<string, number>;
    metrics: Record<string, Record<string, number | null>> | null;
    benchmark_ticker: string | null;
    portfolio: { dates: string[]; values: (number | null)[] } | null;
  }): Promise<ReturnsRow[]> {
    const r = await this.request<{ rows: ReturnsRow[] }>('/allocations/returns', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return r.rows;
  }

  universe(name: 'sp500' | 'us'): Promise<{ name: string; tickers: string[]; date_added: Record<string, string> | null }> {
    return this.request(`/universe/${name}`);
  }

  async resolveTickers(tickers: string[]): Promise<Record<string, string>> {
    const r = await this.request<{ resolved: Record<string, string> }>('/tickers/resolve', {
      method: 'POST',
      body: JSON.stringify({ tickers }),
    });
    return r.resolved;
  }

  clearCache(): Promise<{ entries: number; pe: number; kept?: number }> {
    return this.request('/cache/clear', { method: 'POST' });
  }

  prices(ticker: string, jobId?: string | null, mode: PriceUpdate = 'stored', bars = false): Promise<PriceHistory> {
    const q = new URLSearchParams({ ticker, mode });
    if (jobId) q.set('job', jobId);
    if (bars) q.set('bars', 'true');
    return this.request(`/prices?${q}`);
  }

  storeQuote(ticker: string, refresh = false): Promise<QuoteInfo> {
    const q = new URLSearchParams({ ticker });
    if (refresh) q.set('refresh', 'true');
    return this.request(`/store/quote?${q}`);
  }

  storeStatus(tickers: string[]): Promise<StoreStatus> {
    return this.request('/store/status', { method: 'POST', body: JSON.stringify({ tickers }) });
  }

  storeTickers(): Promise<StoredTicker[]> {
    return this.request('/store/tickers');
  }

  storeUpdate(tickers: string[], mode: 'topup' | 'full'): Promise<StoreReport> {
    return this.request('/store/update', { method: 'POST', body: JSON.stringify({ tickers, mode }) });
  }
}

/** Where a run takes its prices from: stored histories as they are, stored + missing recent days, or everything again. */
export type PriceUpdate = 'stored' | 'topup' | 'full';

export interface StoreMeta {
  first: string;
  last: string;
  rows: number;
  /** Epoch seconds of the last time Yahoo confirmed this history (0 = never). */
  checked: number;
  full: number | null;
}

export interface StoredTicker extends StoreMeta {
  ticker: string;
  current: boolean;
  name?: string | null;
  type?: string | null;
  market_cap?: number | null;
  pe?: number | null;
  /** Day of the last archived Yahoo quote. */
  quote_day?: string | null;
}

/** Last archived Yahoo quote (every field Yahoo sent) and the history of the key figures, one point per archived day. */
export interface QuoteInfo {
  ticker: string;
  symbol: string;
  latest: (Record<string, unknown> & { _day?: string }) | null;
  history: { dates: string[]; fields: Record<string, (number | null)[]> };
}

export interface StoreStatus {
  total: number;
  current: number;
  stale: number;
  missing: number;
  unknown: number;
  stale_oldest_last: string | null;
  stale_newest_last: string | null;
}

export interface StoreReport {
  mode: PriceUpdate;
  stored: number;
  topped_up: number;
  refetched: number;
  downloaded: number;
  unknown: number;
  unchanged: number;
  /** Tickers Yahoo did not answer for at all (network down): kept as stored, still marked not up to date. */
  failed: number;
  /** Stored before the full bars were kept: downloaded once in full to complete them. */
  upgraded?: number;
  /** Quotes archived today (market cap, PE...). */
  quotes?: number;
  yahoo_symbols: number;
  rows_downloaded: number;
  rate_limited: boolean;
}

export interface PriceHistory {
  ticker: string;
  source: 'job' | 'download' | 'store';
  meta?: StoreMeta | null;
  dates: string[];
  close: number[];
  dividends?: { dates: string[]; amounts: number[] } | null;
  bars?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; volume: (number | null)[] } | null;
}
