'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { visibleSeries } from '@/lib/chart-series';
import styles from './Results.module.css';

function compactMoney(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

const money = (v: number) => `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

interface TipItem { dataKey?: string | number; value?: number; color?: string }
interface TipProps {
  active?: boolean;
  label?: string;
  payload?: TipItem[];
  coordinate?: { x?: number; y?: number };
  viewBox?: { y?: number; height?: number };
}

function ValueTooltip({
  active, label, payload, coordinate, viewBox, names, closest, toY,
}: TipProps & { names: Record<string, string>; closest: boolean; toY: (v: number) => number }) {
  if (!active || !payload?.length) return null;
  let items = payload.filter((p) => typeof p.value === 'number' && Number.isFinite(p.value));
  if (closest && coordinate?.y !== undefined && viewBox?.height) {
    const top = viewBox.y ?? 0;
    const h = viewBox.height;
    const mouse = coordinate.y;
    let best: TipItem | null = null;
    let dist = Infinity;
    for (const p of items) {
      const d = Math.abs(top + (1 - toY(p.value!)) * h - mouse);
      if (d < dist) { dist = d; best = p; }
    }
    items = best ? [best] : [];
  } else {
    items = [...items].sort((a, b) => b.value! - a.value!);
  }
  return (
    <div className={styles.chartTip}>
      <div className={styles.chartTipDate}>{label}</div>
      {items.map((p) => (
        <div key={String(p.dataKey)} className={styles.chartTipRow}>
          <i style={{ background: p.color }} />
          <span>{names[String(p.dataKey)] ?? p.dataKey}</span>
          <b>{money(p.value!)}</b>
        </div>
      ))}
    </div>
  );
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

  if (!data.length || !shown.length) return null;

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
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
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
              width={64}
            />
            <Tooltip
              isAnimationActive={false}
              content={<ValueTooltip names={names} closest={closest} toY={toY} />}
            />
            {shown.map((s) => (
              <Line key={s.id} type="monotone" dataKey={s.id} stroke={s.color} dot={false} strokeWidth={s.kind === 'primary' ? 2 : 1.5} isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
