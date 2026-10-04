import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import type { EnginePrefs } from './prefs';
import { normalizeUrl } from './prefs';
import type {
  BenchmarkRow,
  ReturnsRow,
  EngineHealth,
  EngineJob,
  EngineUpdateStatus,
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

/** Contract number this site needs (API_VERSION in engine/backtest_engine/__init__.py): an older
 * engine could misread a request or a result, so runs are refused until it is updated. */
export const ENGINE_API = 3;

export function engineOutdated(health: EngineHealth | null | undefined): boolean {
  return !!health && (health.api ?? 0) < ENGINE_API;
}

const LOCAL_PROBE_MS = 1500;
const CLOUD_PROBE_MS = 6000;
const LOCAL_SEEN_KEY = 'engine-local-seen';

function isLoopback(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url);
}

/** Chrome 142+ (Local Network Access) needs requests from a public page to this PC flagged as
 * such, then asks the user once for permission. Unknown to other browsers, which ignore it. */
function withAddressSpace(url: string, init: RequestInit): RequestInit {
  return isLoopback(url) ? ({ ...init, targetAddressSpace: 'loopback' } as RequestInit) : init;
}

/** Whether to look for an engine on this PC without being asked: always from a local page;
 * from the public site only once an engine answered here, since the first attempt makes
 * Chrome show its local-network permission prompt to every visitor. */
export function localEngineKnown(): boolean {
  if (typeof window === 'undefined') return false;
  if (/^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) return true;
  try {
    return window.localStorage.getItem(LOCAL_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markLocalSeen(): void {
  try {
    window.localStorage.setItem(LOCAL_SEEN_KEY, '1');
  } catch {
    /* private mode */
  }
}

export async function probeEngine(url: string, timeoutMs: number): Promise<EngineHealth | null> {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, withAddressSpace(url, { signal: ctrl.signal, cache: 'no-store' }));
    if (!res.ok) return null;
    const body = (await res.json()) as EngineHealth;
    return body?.engine === 'momentum-backtest' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Picks the engine according to the preference: auto = this PC first, then cloud.
 * forceLocal: the user says an engine runs here (first time from the public site). */
export async function resolveEngine(prefs: EnginePrefs, forceLocal = false): Promise<ResolvedEngine | null> {
  const localUrl = normalizeUrl(prefs.localUrl).replace(/^https:\/\/(127\.0\.0\.1|localhost)/, 'http://$1');
  const cloudUrl = normalizeUrl(prefs.cloudUrl);
  if (prefs.mode !== 'cloud' && (forceLocal || prefs.mode === 'local' || localEngineKnown())) {
    // The first attempt may wait on Chrome's permission prompt.
    const h = await probeEngine(localUrl, forceLocal && !localEngineKnown() ? 60_000 : LOCAL_PROBE_MS);
    if (h) {
      markLocalSeen();
      return { kind: 'local', url: localUrl, health: h };
    }
    if (prefs.mode === 'local' || forceLocal) return null;
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
      res = await fetch(`${this.url}${path}`, withAddressSpace(this.url, { ...init, headers, cache: 'no-store' }));
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

  /** Binary-safe request (library files): the response is returned untouched. */
  async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = await accessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, withAddressSpace(this.url, { ...init, headers, cache: 'no-store' }));
    } catch {
      throw new EngineError('Moteur injoignable. Est-il toujours lancé ?');
    }
    if (!res.ok && res.status !== 404) {
      let detail = res.statusText;
      try {
        const body = await res.json();
        detail = typeof body?.detail === 'string' ? body.detail : detail;
      } catch {
        /* not json */
      }
      throw new EngineError(detail || `HTTP ${res.status}`, res.status);
    }
    return res;
  }

  /** Stores bytes in the local library (PUT). */
  async libPut(path: string, body: Blob | string): Promise<void> {
    await this.raw(`/library/${path}`, { method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  /** Reads a library file; null when it does not exist. */
  async libGet(path: string): Promise<Blob | null> {
    const res = await this.raw(`/library/${path}`);
    return res.status === 404 ? null : res.blob();
  }

  async libDelete(path: string): Promise<void> {
    await this.raw(`/library/${path}`, { method: 'DELETE' });
  }

  libJson<T>(path: string): Promise<T> {
    return this.request(`/library/${path}`);
  }

  storageUsage(): Promise<LocalUsage> {
    return this.request('/storage');
  }

  storagePurge(body: { target: 'runs' | 'ibkr' | 'cache' | 'prices'; older_than_days?: number | null; keep_pinned?: boolean; user?: string | null }): Promise<{ removed: number; freed: number }> {
    return this.request('/storage/purge', { method: 'POST', body: JSON.stringify(body) });
  }

  storageSettings(): Promise<LocalStorageSettings> {
    return this.request('/storage/settings');
  }

  setStorageSettings(patch: Partial<LocalStorageSettings>): Promise<LocalStorageSettings> {
    return this.request('/storage/settings', { method: 'PUT', body: JSON.stringify(patch) });
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

  updateCheck(): Promise<EngineUpdateStatus> {
    return this.request('/update/check', { method: 'POST' });
  }

  updateApply(): Promise<EngineUpdateStatus & { restarting: boolean }> {
    return this.request('/update/apply', { method: 'POST' });
  }
}

export interface LocalStorageSettings {
  /** Runs older than this many days are deleted automatically (0 = never). */
  auto_clean_days: number;
  keep_pinned: boolean;
  /** The engine removes the oldest unprotected runs when the disk has less than this many GB free (0 = never). */
  min_free_gb?: number;
}

export interface LocalUsage {
  home: string;
  total: number;
  folders: { name: string; label: string; bytes: number; files: number }[];
  disk: { free: number | null; total: number | null };
  settings: LocalStorageSettings;
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
