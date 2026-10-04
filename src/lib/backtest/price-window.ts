/** Pure helpers for price charts shown over a chosen date window, optionally as % change from its first day. */

export interface DateWindow {
  /** Inclusive index of the first day inside the window. */
  start: number;
  /** Inclusive index of the last day inside the window. */
  end: number;
}

/**
 * Index window of a sorted ISO date axis for an optional `from` / `to` ('' = open on that side).
 * `from` lands on the first day on or after it, `to` on the last day on or before it.
 * Null when the axis is empty or no day falls inside the window.
 */
export function dateWindow(dates: readonly string[], from: string, to: string): DateWindow | null {
  if (!dates.length) return null;
  let start = 0;
  if (from) {
    start = dates.findIndex((d) => d >= from);
    if (start < 0) return null;
  }
  let end = dates.length - 1;
  if (to) {
    while (end >= 0 && dates[end] > to) end--;
    if (end < 0) return null;
  }
  return start <= end ? { start, end } : null;
}

/** % change of each value against `base`, (v / base - 1) * 100; gaps (null / NaN) stay null. */
export function pctVersus(values: ArrayLike<number | null>, base: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = v === null || v === undefined || !Number.isFinite(v) || !(base > 0) ? null : (v / base - 1) * 100;
  }
  return out;
}

export interface WindowStats {
  /** Total change over the window, as a fraction (0.12 = +12 %). */
  change: number;
  /** Worst peak-to-trough fall inside the window, as a negative fraction (0 when none). */
  maxDrawdown: number;
}

/** Change and worst drawdown of `close` between two inclusive indexes. Null when it cannot be computed. */
export function windowStats(close: ArrayLike<number>, w: DateWindow): WindowStats | null {
  const first = close[w.start];
  const last = close[w.end];
  if (!(first > 0) || !Number.isFinite(last)) return null;
  let peak = -Infinity;
  let dd = 0;
  for (let i = w.start; i <= w.end; i++) {
    const c = close[i];
    if (!Number.isFinite(c)) continue;
    if (c > peak) peak = c;
    else dd = Math.min(dd, c / peak - 1);
  }
  return { change: last / first - 1, maxDrawdown: dd };
}
