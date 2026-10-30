'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { visibleSeries } from '@/lib/chart-series';
import { formatChartTooltipDate } from '@/lib/dates';
import styles from './Results.module.css';

function compactMoney(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

const money = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

const PLOT_LEFT = 4;
const PLOT_RIGHT = 16;
const PLOT_TOP = 8;
const Y_AXIS = 64;

function pointerIndex(clientX: number, rect: DOMRect, length: number): number {
  if (length < 2) return 0;
  const plotWidth = rect.width - Y_AXIS - PLOT_LEFT - PLOT_RIGHT;
  const x = clientX - rect.left - Y_AXIS - PLOT_LEFT;
  const ratio = Math.max(0, Math.min(1, x / Math.max(plotWidth, 1)));
  return Math.round(ratio * (length - 1));
}

export default function ValueChart({
  data,
  series,
  hidden,
  title,
  subtitle,
}: {
  data: MultiSeriesChartPoint[];
  series: ChartSeriesDef[];
  hidden: Set<string>;
  title: string;
  subtitle: string;
}) {
  const [log, setLog] = useState(true);
  const [closest, setClosest] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const pending = useRef<{ x: number; y: number } | null>(null);
  const frame = useRef(0);
  const shown = useMemo(() => visibleSeries(series, hidden).filter((s) => s.kind !== 'benchmark'), [series, hidden]);
  const names = useMemo(() => Object.fromEntries(shown.map((s) => [s.id, s.label])), [shown]);

  // Explicit domain: the tooltip maps values to pixels with it to find the curve under the cursor.
  const domain = useMemo<[number, number]>(() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of data) {
      for (const s of shown) {
        const v = row[s.id];
        if (typeof v === 'number' && Number.isFinite(v) && (!log || v > 0)) {
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    if (!Number.isFinite(lo)) return log ? [1, 10] : [0, 1];
    return log ? [lo * 0.9, hi * 1.1] : [0, hi * 1.05];
  }, [data, shown, log]);

  const toY = useMemo(() => {
    const [lo, hi] = domain;
    if (log) {
      const a = Math.log(lo);
      const span = Math.log(hi) - a || 1;
      return (v: number) => (v > 0 ? (Math.log(v) - a) / span : 0);
    }
    const span = hi - lo || 1;
    return (v: number) => (v - lo) / span;
  }, [domain, log]);

  const snap = useRef({ data, shown, names, closest, toY });
  snap.current = { data, shown, names, closest, toY };
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);

  if (!data.length || !shown.length) return null;

  const paint = () => {
    const line = lineRef.current;
    const tip = tipRef.current;
    const rows = rowsRef.current;
    const node = plotRef.current;
    const ev = pending.current;
    if (!line || !tip || !rows || !node || !ev) return;
    const cur = snap.current;
    const rect = node.getBoundingClientRect();
    const index = pointerIndex(ev.x, rect, cur.data.length);
    const point = cur.data[index];
    if (!point) { line.hidden = true; tip.hidden = true; return; }
    const plotWidth = rect.width - Y_AXIS - PLOT_LEFT - PLOT_RIGHT;
    const x = Y_AXIS + PLOT_LEFT + (index / Math.max(cur.data.length - 1, 1)) * plotWidth;
    const plotH = rect.height - PLOT_TOP;
    let items = cur.shown.flatMap((s) => {
      const v = point[s.id];
      return typeof v === 'number' && Number.isFinite(v) ? [{ id: s.id, color: s.color, value: v }] : [];
    });
    if (cur.closest) {
      let best = items[0];
      let dist = Infinity;
      for (const item of items) {
        const d = Math.abs(PLOT_TOP + (1 - cur.toY(item.value)) * plotH - ev.y);
        if (d < dist) { dist = d; best = item; }
      }
      items = best ? [best] : [];
    } else {
      items.sort((a, b) => b.value - a.value);
    }
    line.hidden = false;
    tip.hidden = false;
    line.style.left = `${x}px`;
    tip.style.left = `${x}px`;
    tip.style.transform = x > rect.width * 0.62 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
    if (dateRef.current) dateRef.current.textContent = formatChartTooltipDate(point.date);
    rows.replaceChildren(...items.map((p) => {
      const row = document.createElement('div');
      row.className = styles.chartTipRow;
      const swatch = document.createElement('i');
      swatch.style.background = p.color;
      const name = document.createElement('span');
      name.textContent = cur.names[p.id] ?? p.id;
      const value = document.createElement('b');
      value.textContent = money(p.value);
      row.append(swatch, name, value);
      return row;
    }));
  };

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>{title}</div>
          <div className={styles.cardSub}>{subtitle}</div>
        </div>
        <div className={styles.toolbarInline}>
          <div className={styles.segment} title="Infobulle : toutes les courbes à la date survolée, ou seulement la plus proche du curseur">
            <button type="button" className={!closest ? styles.segOn : ''} onClick={() => setClosest(false)}>Toutes</button>
            <button type="button" className={closest ? styles.segOn : ''} onClick={() => setClosest(true)}>La plus proche</button>
          </div>
          <div className={styles.segment}>
            <button type="button" className={log ? styles.segOn : ''} onClick={() => setLog(true)}>Log</button>
            <button type="button" className={!log ? styles.segOn : ''} onClick={() => setLog(false)}>Linéaire</button>
          </div>
        </div>
      </div>
      <div style={{ height: 360, padding: '0 0.5rem 0.75rem' }}>
        <div
          ref={plotRef}
          className={styles.valuePlot}
          onMouseMove={(e) => {
            pending.current = { x: e.clientX, y: e.clientY };
            if (frame.current) return;
            frame.current = requestAnimationFrame(() => { frame.current = 0; paint(); });
          }}
          onMouseLeave={() => {
            pending.current = null;
            if (lineRef.current) lineRef.current.hidden = true;
            if (tipRef.current) tipRef.current.hidden = true;
          }}
        >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: PLOT_TOP, right: PLOT_RIGHT, left: PLOT_LEFT, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="date" stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={48} tickFormatter={(d: string) => d.slice(0, 7)} />
            <YAxis
              scale={log ? 'log' : 'linear'}
              domain={domain}
              allowDataOverflow
              tickFormatter={compactMoney}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={Y_AXIS}
            />
            {shown.map((s) => (
              <Line key={s.id} type="linear" dataKey={s.id} stroke={s.color} dot={false} strokeWidth={s.kind === 'primary' ? 2 : 1.5} isAnimationActive={false} connectNulls activeDot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <div ref={lineRef} className={styles.evoLine} hidden />
        <div ref={tipRef} className={styles.chartTip} hidden style={{ position: 'absolute', top: 8, zIndex: 5, pointerEvents: 'none' }}>
          <div ref={dateRef} className={styles.chartTipDate} />
          <div ref={rowsRef} />
        </div>
        </div>
      </div>
    </div>
  );
}
