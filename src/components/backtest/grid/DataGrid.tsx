'use client';

import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import styles from './DataGrid.module.css';

export interface GridColumn<T> {
  key: string;
  label: string;
  width?: number;
  align?: 'left' | 'right' | 'center';
  title?: string;
  /** Raw value used for sorting and CSV. */
  value: (row: T, index: number) => number | string | null | undefined;
  /** Display text; defaults to String(value). */
  format?: (value: number | string | null | undefined, row: T) => ReactNode;
  cellStyle?: (value: number | string | null | undefined, row: T) => CSSProperties | undefined;
  sortable?: boolean;
}

export interface DataGridProps<T> {
  columns: GridColumn<T>[];
  rows: T[];
  rowKey?: (row: T, index: number) => string | number;
  rowHeight?: number;
  /** Max visible height in px; the grid shrinks to fit fewer rows. */
  maxHeight?: number;
  /** Keep the first column visible while scrolling horizontally. */
  freezeFirst?: boolean;
  initialSort?: { key: string; dir: 'asc' | 'desc' } | null;
  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;
  csvName?: string;
  toolbar?: ReactNode;
  empty?: ReactNode;
}

const OVERSCAN = 8;

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Virtualized table: only visible rows are in the DOM (fine with 100k+ rows). */
export default function DataGrid<T>({
  columns,
  rows,
  rowKey,
  rowHeight = 30,
  maxHeight = 480,
  freezeFirst = true,
  initialSort = null,
  onRowClick,
  selectedKey,
  csvName,
  toolbar,
  empty,
}: DataGridProps<T>) {
  const [sort, setSort] = useState(initialSort);
  const [scrollTop, setScrollTop] = useState(0);
  // Column widths dragged by the person (key -> px); the column's own width is the default.
  const [widths, setWidths] = useState<Record<string, number>>({});
  const widthOf = useCallback((c: GridColumn<T>) => widths[c.key] ?? c.width ?? 120, [widths]);
  const scroller = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows.map((r, i) => ({ r, i }));
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows.map((r, i) => ({ r, i }));
    const dir = sort.dir === 'asc' ? 1 : -1;
    const keyed = rows.map((r, i) => ({ r, i, v: col.value(r, i) }));
    keyed.sort((a, b) => {
      const av = a.v;
      const bv = b.v;
      const an = av === null || av === undefined || (typeof av === 'number' && !Number.isFinite(av));
      const bn = bv === null || bv === undefined || (typeof bv === 'number' && !Number.isFinite(bv));
      if (an || bn) return an === bn ? 0 : an ? 1 : -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), 'fr', { numeric: true }) * dir;
    });
    return keyed;
  }, [rows, columns, sort]);

  const template = useMemo(() => columns.map((c) => `${widthOf(c)}px`).join(' '), [columns, widthOf]);
  const totalWidth = useMemo(() => columns.reduce((a, c) => a + widthOf(c), 0), [columns, widthOf]);
  const bodyHeight = sorted.length * rowHeight;
  // Height taken by the horizontal scrollbar, so short tables are not cut by it.
  const [hbar, setHbar] = useState(0);
  const hasRows = rows.length > 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => {
      if (!el.clientWidth) return;
      setHbar(el.scrollWidth > el.clientWidth ? el.offsetHeight - el.clientHeight - 2 : 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRows, totalWidth]);
  const viewport = Math.min(maxHeight, bodyHeight + rowHeight + 2 + Math.max(0, hbar));
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(sorted.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN);

  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (scroller.current) setScrollTop(scroller.current.scrollTop);
    });
  }, []);

  const toggleSort = (c: GridColumn<T>) => {
    if (c.sortable === false) return;
    setSort((s) => (s?.key !== c.key ? { key: c.key, dir: 'desc' } : s.dir === 'desc' ? { key: c.key, dir: 'asc' } : null));
  };

  const exportCsv = () => {
    const lines = [columns.map((c) => csvCell(c.label)).join(',')];
    for (const { r, i } of sorted) lines.push(columns.map((c) => csvCell(c.value(r, i))).join(','));
    const blob = new Blob([`\ufeff${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${csvName ?? 'table'}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const startResize = (e: ReactPointerEvent<HTMLSpanElement>, c: GridColumn<T>) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widthOf(c);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) =>
      setWidths((w) => ({ ...w, [c.key]: Math.max(48, Math.round(startW + ev.clientX - startX)) }));
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const cellClass = (c: GridColumn<T>, k: number) =>
    `${styles.cell} ${c.align === 'right' ? styles.right : c.align === 'center' ? styles.center : ''} ${freezeFirst && k === 0 ? styles.frozen : ''}`;

  return (
    <div className={styles.wrap}>
      {(toolbar || csvName) && (
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>{toolbar}</div>
          {csvName && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!rows.length}>
              CSV
            </button>
          )}
        </div>
      )}
      {rows.length === 0 ? (
        <div className={styles.empty}>{empty ?? 'Aucune donnée.'}</div>
      ) : (
        <div ref={scroller} className={styles.scroller} style={{ height: viewport }} onScroll={onScroll} role="grid">
          <div style={{ width: totalWidth, minWidth: '100%' }}>
            <div className={`${styles.row} ${styles.head}`} style={{ gridTemplateColumns: template, height: rowHeight }} role="row">
              {columns.map((c, k) => (
                <div
                  key={c.key}
                  role="columnheader"
                  title={c.title ?? c.label}
                  className={`${cellClass(c, k)} ${styles.headCell} ${c.sortable === false ? '' : styles.sortable}`}
                  onClick={() => toggleSort(c)}
                >
                  <span className={styles.headLabel}>{c.label}</span>
                  {sort?.key === c.key
                    ? <span className={styles.sortMark}>{sort.dir === 'desc' ? '▼' : '▲'}</span>
                    : c.sortable !== false && <span className={styles.sortHint} aria-hidden>⇅</span>}
                  <span
                    className={styles.resizer}
                    title="Glisser pour redimensionner · double-clic pour réinitialiser"
                    onPointerDown={(e) => startResize(e, c)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setWidths((w) => {
                        const next = { ...w };
                        delete next[c.key];
                        return next;
                      });
                    }}
                  />
                </div>
              ))}
            </div>
            <div style={{ height: bodyHeight, position: 'relative' }}>
              {sorted.slice(first, last).map(({ r, i }, n) => {
                const key = rowKey ? rowKey(r, i) : i;
                return (
                  <div
                    key={key}
                    role="row"
                    className={`${styles.row} ${onRowClick ? styles.clickable : ''} ${selectedKey !== undefined && selectedKey === key ? styles.selected : ''}`}
                    style={{ gridTemplateColumns: template, height: rowHeight, transform: `translateY(${(first + n) * rowHeight}px)` }}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                  >
                    {columns.map((c, k) => {
                      const v = c.value(r, i);
                      return (
                        <div key={c.key} role="gridcell" className={cellClass(c, k)} style={c.cellStyle?.(v, r)}>
                          {c.format ? c.format(v, r) : v === null || v === undefined ? '' : String(v)}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
