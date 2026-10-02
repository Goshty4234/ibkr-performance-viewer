import type { PortfolioConfig, RunOptions } from '@/lib/engine/types';

export interface RunRequest {
  portfolios: PortfolioConfig[];
  options: RunOptions;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonical(v);
    }
    return out;
  }
  return value;
}

/**
 * sha256 of the normalized request. Portfolio order is ignored: the engine builds one
 * simulation axis from the whole set, so the same set gives the same numbers in any order.
 */
export async function requestKey(req: RunRequest): Promise<string> {
  const portfolios = [...req.portfolios].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const { price_update: _prices, ...options } = req.options;
  return sha256(JSON.stringify(canonical({ portfolios, options })));
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const NOT_IDENTITY_OPTIONS = new Set(['end_date', 'align_start', 'start_date', 'price_update']);

/**
 * Per portfolio: its config (fusion members included) + the run options, requested dates aside.
 * Cheap pre-filter computed without the engine; the engine's history_key then confirms with the
 * effective start (a requested start before the data begins changes nothing).
 */
export async function configKeys(req: RunRequest): Promise<string[]> {
  const options = Object.fromEntries(Object.entries(req.options).filter(([k]) => !NOT_IDENTITY_OPTIONS.has(k)));
  const strip = (p: PortfolioConfig) => {
    const { end_date_user: _end, start_date_user: _start, ...rest } = p as PortfolioConfig & { end_date_user?: unknown; start_date_user?: unknown };
    return rest;
  };
  return Promise.all(req.portfolios.map((p) => {
    const f = p.fusion_portfolio;
    const members = f?.enabled
      ? req.portfolios.filter((m) => !m.fusion_portfolio?.enabled && (!f.selected_portfolios.length || f.selected_portfolios.includes(m.name))).map(strip)
      : [];
    return sha256(JSON.stringify(canonical({ portfolio: strip(p), members, options })));
  }));
}

// ---- market clock (mirrors engine yahoo.smart_ttl) --------------------------------------

const NY = 'America/New_York';
const OPEN = 9 * 60 + 30;
// The final daily bar is published a few minutes after the 16:00 close.
const SETTLED = 16 * 60 + 20;

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short',
});

function nyParts(d: Date) {
  const p = Object.fromEntries(nyFormat.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, minutes: +p.hour * 60 + +p.minute, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
}

/** UTC instant of a New York wall-clock time. */
function nyInstant(y: number, m: number, d: number, minutes: number): Date {
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const wall = nyParts(new Date(guess));
  const wallMs = Date.UTC(wall.y, wall.m - 1, wall.d, Math.floor(wall.minutes / 60), wall.minutes % 60);
  return new Date(guess - (wallMs - guess));
}

function isWeekend(y: number, m: number, d: number): boolean {
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 || day === 6;
}

/** Daily bars of 24/7 assets keep changing until midnight UTC. */
export function isRoundTheClock(ticker: string): boolean {
  const t = ticker.toUpperCase();
  return t.endsWith('-USD') || t.endsWith('=X') || t.endsWith('=F') || t === 'BITCOIN';
}

/** Last moment a new daily bar became final (16:20 New York on the latest weekday). */
function lastSettle(now: Date): Date {
  const p = nyParts(now);
  const day = new Date(Date.UTC(p.y, p.m - 1, p.d));
  if (p.weekend || p.minutes < SETTLED) day.setUTCDate(day.getUTCDate() - 1);
  while (isWeekend(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) day.setUTCDate(day.getUTCDate() - 1);
  return nyInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), SETTLED);
}

function nyDay(d: Date): string {
  const p = nyParts(d);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Same calendar day in New York (the market's day). */
export function sameNyDay(a: Date, b = new Date()): boolean {
  return nyDay(a) === nyDay(b);
}

/** Moment the daily bar of `day` (YYYY-MM-DD) stopped changing. */
function finalAt(day: string, crypto: boolean): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  const stocks = nyInstant(y, m, d, SETTLED);
  return crypto ? new Date(Math.max(stocks.getTime(), Date.UTC(y, m - 1, d + 1, 0, 30))) : stocks;
}

/** Were the prices of `day` final when a run was made at `createdAt`? Then that run is reproducible. */
export function barFinalAt(createdAt: Date, day: string, crypto: boolean): boolean {
  return createdAt >= finalAt(day, crypto);
}

/** Latest day whose bar is final now: a run launched now "up to today" ends there. */
export function latestFinalDay(crypto: boolean, now = new Date()): string {
  const stocks = nyDay(lastSettle(now));
  if (!crypto) return stocks;
  const utc = new Date(now.getTime() - 30 * 60_000);
  utc.setUTCDate(utc.getUTCDate() - 1);
  const c = utc.toISOString().slice(0, 10);
  return c < stocks ? c : stocks;
}

export function requestHasCrypto(req: RunRequest): boolean {
  return req.portfolios.some((p) => p.stocks.some((s) => s.ticker && isRoundTheClock(s.ticker)) || isRoundTheClock(p.benchmark_ticker ?? ''));
}

function marketOpen(now: Date): boolean {
  const p = nyParts(now);
  return !p.weekend && p.minutes >= OPEN && p.minutes < SETTLED;
}

/**
 * Would a run launched now read exactly the prices an earlier run (created at `createdAt`) read?
 * - fixed end date: yes once that day's bar was final when the earlier run was made;
 * - up to today: only while the market is closed and the earlier run came after the last close
 *   (intraday bars and 24/7 assets move all the time).
 * Holidays are treated as trading days, which can only answer "no" too often, never "yes" wrongly.
 */
export function sameMarketData(createdAt: Date, req: RunRequest, now = new Date()): boolean {
  const crypto = requestHasCrypto(req);
  const end = req.options.end_date;
  if (end) {
    const final = finalAt(end, crypto);
    return createdAt >= final && now >= final;
  }
  if (crypto || marketOpen(now)) return false;
  return createdAt >= lastSettle(now);
}
