import type { DatePreset } from './types';

/**
 * What a person chose to see on the page of an IBKR account (comparisons, hidden curves, period,
 * positions tab). Stored with the account in the database, so it follows them from one computer to
 * the next. Only small, validated values are kept: this is a preference, never data.
 */
export interface AccountViewPrefs {
  benchmarks?: string[];
  accountIds?: string[];
  backtests?: { runId: string; index: number; label: string }[];
  hidden?: string[];
  preset?: DatePreset | null;
  holdingsTab?: 'repartition' | 'evolution' | 'positions' | 'transactions';
}

const BENCHMARKS = ['SPY', 'QQQ', 'XIU'];
const PRESETS: DatePreset[] = ['1W', '1M', 'MTD', '3M', '6M', '1Y', 'YTD', 'MAX'];
const TABS = ['repartition', 'evolution', 'positions', 'transactions'] as const;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;
const RUN_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const MAX_COMPARED_ACCOUNTS = 20;
export const MAX_COMPARED_BACKTESTS = 20;
export const MAX_HIDDEN_SERIES = 200;

/** Keeps only known, well-formed values and caps every list (the input may come from anywhere). */
export function sanitizeViewPrefs(raw: unknown): AccountViewPrefs {
  const out: AccountViewPrefs = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  if (Array.isArray(r.benchmarks)) {
    out.benchmarks = [...new Set(r.benchmarks.filter((x): x is string => typeof x === 'string' && BENCHMARKS.includes(x)))];
  }
  if (Array.isArray(r.accountIds)) {
    out.accountIds = [...new Set(r.accountIds.filter((x): x is string => typeof x === 'string' && UUID_RE.test(x)))].slice(0, MAX_COMPARED_ACCOUNTS);
  }
  if (Array.isArray(r.backtests)) {
    const seen = new Set<string>();
    const list: NonNullable<AccountViewPrefs['backtests']> = [];
    for (const b of r.backtests) {
      if (!b || typeof b !== 'object') continue;
      const { runId, index, label } = b as Record<string, unknown>;
      if (typeof runId !== 'string' || !RUN_RE.test(runId)) continue;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 9999) continue;
      const key = `${runId}:${index}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ runId, index, label: typeof label === 'string' ? label.slice(0, 200) : runId });
      if (list.length >= MAX_COMPARED_BACKTESTS) break;
    }
    out.backtests = list;
  }
  if (Array.isArray(r.hidden)) {
    out.hidden = [...new Set(r.hidden.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 120))].slice(0, MAX_HIDDEN_SERIES);
  }
  if (r.preset === null) out.preset = null;
  else if (typeof r.preset === 'string' && (PRESETS as string[]).includes(r.preset)) out.preset = r.preset as DatePreset;
  if (typeof r.holdingsTab === 'string' && (TABS as readonly string[]).includes(r.holdingsTab)) out.holdingsTab = r.holdingsTab as AccountViewPrefs['holdingsTab'];
  return out;
}
