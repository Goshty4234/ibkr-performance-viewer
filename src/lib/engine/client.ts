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
      throw new EngineError(detail || `HTTP ${res.status}`, res.status);
    }
    return res.text();
  }

  submit(portfolios: PortfolioConfig[], options: Partial<RunOptions>, label?: string): Promise<EngineJob> {
    return this.request('/jobs', { method: 'POST', body: JSON.stringify({ portfolios, options, label }) });
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

  clearCache(): Promise<{ entries: number; pe: number }> {
    return this.request('/cache/clear', { method: 'POST' });
  }

  prices(ticker: string, jobId?: string | null): Promise<PriceHistory> {
    const q = new URLSearchParams({ ticker });
    if (jobId) q.set('job', jobId);
    return this.request(`/prices?${q}`);
  }
}

export interface PriceHistory {
  ticker: string;
  source: 'job' | 'download';
  dates: string[];
  close: number[];
}
