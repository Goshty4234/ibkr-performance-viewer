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
  const shown = useMemo(() => visibleSeries(series, hidden).filter((s) => s.kind !== 'benchmark'), [series, hidden]);
  const names = useMemo(() => Object.fromEntries(shown.map((s) => [s.id, s.label])), [shown]);

  if (!data.length || !shown.length) return null;

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>{title}</div>
          <div className={styles.cardSub}>{subtitle}</div>
        </div>
        <div className={styles.segment}>
          <button type="button" className={log ? styles.segOn : ''} onClick={() => setLog(true)}>Log</button>
          <button type="button" className={!log ? styles.segOn : ''} onClick={() => setLog(false)}>Linéaire</button>
        </div>
      </div>
      <div style={{ height: 360, padding: '0 0.5rem 0.75rem' }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="date" stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={48} tickFormatter={(d: string) => d.slice(0, 7)} />
            <YAxis
              scale={log ? 'log' : 'linear'}
              domain={log ? ['auto', 'auto'] : [0, 'auto']}
              allowDataOverflow={false}
              tickFormatter={compactMoney}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={64}
            />
            <Tooltip
              formatter={(v: number, key: string) => [`$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`, names[key] ?? key]}
              labelFormatter={(d) => String(d)}
              contentStyle={{ background: '#141c2b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
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
