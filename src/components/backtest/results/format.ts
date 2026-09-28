import type { CSSProperties } from 'react';

type Num = number | string | null | undefined;

function asNum(v: Num): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isNaN(n) ? null : n;
}

export function pct(v: Num, digits = 2): string {
  const n = asNum(v);
  return n === null || !Number.isFinite(n) ? 'N/A' : `${n.toFixed(digits)}%`;
}

export function num(v: Num, digits = 2): string {
  const n = asNum(v);
  return n === null || !Number.isFinite(n) ? 'N/A' : n.toFixed(digits);
}

export function money(v: Num, digits = 2): string {
  const n = asNum(v);
  if (n === null || !Number.isFinite(n)) return 'N/A';
  const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return n < 0 ? `-$${s}` : `$${s}`;
}

export function qty(v: Num, digits = 4): string {
  const n = asNum(v);
  if (n === null || !Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Green / red background whose intensity grows with |value| (capped at `scale`). */
export function gradient(v: Num, scale = 30): CSSProperties | undefined {
  const n = asNum(v);
  if (n === null || !Number.isFinite(n) || n === 0) return undefined;
  const a = Math.min(1, Math.abs(n) / scale) * 0.45 + 0.05;
  return { background: n > 0 ? `rgba(45, 212, 168, ${a})` : `rgba(255, 107, 122, ${a})` };
}

export function signColor(v: Num): CSSProperties | undefined {
  const n = asNum(v);
  if (n === null || !Number.isFinite(n) || n === 0) return undefined;
  return { color: n > 0 ? 'var(--green)' : 'var(--red, #ff6b7a)' };
}

export function nanToNull(v: number): number | null {
  return Number.isNaN(v) ? null : v;
}
