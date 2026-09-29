'use client';

import { type ReactNode, useMemo, useState } from 'react';
import styles from './SortableTh.module.css';

export type SortValue = number | string | null | undefined;
export interface SortState { key: string; dir: 'asc' | 'desc' }

const missing = (v: SortValue) => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));

/**
 * Click-to-sort for plain tables: 1st click = descending for numbers (ascending for text),
 * 2nd = reverse, 3rd = original order. Missing values always last; `pinned` rows stay on top.
 * Pass module-level `getters` / `pinned` so the memo is not recomputed on every render.
 */
export function useTableSort<T>(rows: T[], getters: Record<string, (row: T) => SortValue>, pinned?: (row: T) => boolean) {
  const [sort, setSort] = useState<SortState | null>(null);
  const sorted = useMemo(() => {
    const get = sort ? getters[sort.key] : undefined;
    if (!sort || !get) return rows;
    const sign = sort.dir === 'asc' ? 1 : -1;
    const top = pinned ? rows.filter(pinned) : [];
    const rest = pinned ? rows.filter((r) => !pinned(r)) : [...rows];
    const keyed = rest.map((r) => ({ r, v: get(r) }));
    keyed.sort((a, b) => {
      const am = missing(a.v);
      const bm = missing(b.v);
      if (am || bm) return am === bm ? 0 : am ? 1 : -1;
      if (typeof a.v === 'number' && typeof b.v === 'number') return (a.v - b.v) * sign;
      return String(a.v).localeCompare(String(b.v), 'fr', { numeric: true }) * sign;
    });
    return [...top, ...keyed.map((k) => k.r)];
  }, [rows, sort, getters, pinned]);

  const toggle = (key: string, text: boolean) =>
    setSort((s) => {
      const first: SortState['dir'] = text ? 'asc' : 'desc';
      if (s?.key !== key) return { key, dir: first };
      return s.dir === first ? { key, dir: first === 'asc' ? 'desc' : 'asc' } : null;
    });

  return { sorted, sort, toggle };
}

export function SortableTh({ k, sort, onSort, text = false, className, title, children }: {
  k: string;
  sort: SortState | null;
  onSort: (key: string, text: boolean) => void;
  text?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const on = sort?.key === k;
  return (
    <th
      className={`${styles.th} ${on ? styles.on : ''} ${className ?? ''}`}
      title={title ?? 'Cliquer pour trier (3e clic : ordre d’origine)'}
      aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(k, text)}
    >
      {children}
      <span className={styles.mark} aria-hidden>{on ? (sort!.dir === 'desc' ? '▼' : '▲') : '⇅'}</span>
    </th>
  );
}
