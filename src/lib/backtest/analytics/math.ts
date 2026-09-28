/** NumPy / pandas reductions with the same NaN and ddof conventions. */

export function dropNaN(a: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) out.push(a[i]);
  return out;
}

export function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

export function mean(a: ArrayLike<number>): number {
  return a.length ? sum(a) / a.length : NaN;
}

export function median(a: ArrayLike<number>): number {
  return quantile(a, 0.5);
}

/** Linear interpolation (numpy / pandas default). */
export function quantile(a: ArrayLike<number>, q: number): number {
  const n = a.length;
  if (!n) return NaN;
  const s = Float64Array.from(a).sort();
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function variance(a: ArrayLike<number>, ddof = 1): number {
  const n = a.length;
  if (n - ddof <= 0) return NaN;
  const m = mean(a);
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - m;
    ss += d * d;
  }
  return ss / (n - ddof);
}

export function std(a: ArrayLike<number>, ddof = 1): number {
  return Math.sqrt(variance(a, ddof));
}

export function cov(a: ArrayLike<number>, b: ArrayLike<number>, ddof = 1): number {
  const n = a.length;
  if (n - ddof <= 0) return NaN;
  const ma = mean(a);
  const mb = mean(b);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - ddof);
}

export function min(a: ArrayLike<number>): number {
  let m = NaN;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i]) && !(a[i] >= m)) m = a[i];
  return m;
}

export function max(a: ArrayLike<number>): number {
  let m = NaN;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i]) && !(a[i] <= m)) m = a[i];
  return m;
}

export function isNum(v: number | null | undefined): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

export function nullable(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}
