/** One band per ticker that ever has a weight in the window. Nothing is folded into "Autres". */

export interface AllocationEvolution {
  dates: string[];
  weights: Record<string, (number | null)[]>;
  factor: number;
}

export interface AllocationView {
  /** First index of the window inside `dates`. */
  i0: number;
  /** One entry per simulated day in the window. The painted chart is a sample of these. */
  count: number;
  /** Paint order: largest peak at the bottom, cash last so it sits on top. */
  keys: string[];
  paint: Record<string, number | string>[];
}

const PAINT_MAX = 480;

export const EMPTY_ALLOCATION_VIEW: AllocationView = { i0: 0, count: 0, keys: [], paint: [] };

export function paintIndices(n: number): number[] {
  if (n <= PAINT_MAX) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (PAINT_MAX - 1);
  const out: number[] = [];
  let prev = -1;
  for (let k = 0; k < PAINT_MAX; k++) {
    const i = Math.round(k * step);
    if (i !== prev) out.push(i);
    prev = i;
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

function indexOnOrBefore(dates: string[], day: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= day) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Stocks with a real weight that day. Cash is not a stock. */
export function heldCount(ev: AllocationEvolution, i: number): number {
  let n = 0;
  for (const [t, series] of Object.entries(ev.weights)) {
    if (t === 'CASH') continue;
    if ((series[i] ?? 0) * ev.factor > 0.05) n += 1;
  }
  return n;
}

export function buildAllocationView(ev: AllocationEvolution, start: string, end: string): AllocationView {
  if (!ev.dates.length) return EMPTY_ALLOCATION_VIEW;
  const i0 = start ? ev.dates.findIndex((d) => d >= start) : 0;
  const i1 = end ? indexOnOrBefore(ev.dates, end) : ev.dates.length - 1;
  if (i0 < 0 || i1 < i0) return EMPTY_ALLOCATION_VIEW;
  const ranked = Object.keys(ev.weights).map((t) => {
    let peak = 0;
    const series = ev.weights[t];
    for (let i = i0; i <= i1; i++) {
      const v = series[i] ?? 0;
      if (v > peak) peak = v;
    }
    return { t, peak };
  }).filter((x) => x.peak > 0).sort((a, b) => b.peak - a.peak);
  const stocks = ranked.filter((x) => x.t !== 'CASH').map((x) => x.t);
  const keys = ranked.some((x) => x.t === 'CASH') ? [...stocks, 'CASH'] : stocks;
  if (!keys.length) return EMPTY_ALLOCATION_VIEW;
  const count = i1 - i0 + 1;
  const paint: Record<string, number | string>[] = [];
  for (const local of paintIndices(count)) {
    const i = i0 + local;
    const row: Record<string, number | string> = { date: ev.dates[i], n: heldCount(ev, i) };
    for (const t of keys) row[t] = Math.max(0, (ev.weights[t][i] ?? 0) * ev.factor);
    paint.push(row);
  }
  return { i0, count, keys, paint };
}
