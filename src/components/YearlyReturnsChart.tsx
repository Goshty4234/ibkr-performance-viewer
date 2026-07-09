'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { visibleSeries } from '@/lib/chart-series';
import { buildYearlyReturnsChartData } from '@/lib/period-performance';
import { fmtPct } from '@/lib/performance';
import styles from './PeriodTables.module.css';

interface Props {
  data: MultiSeriesChartPoint[];
  series: ChartSeriesDef[];
  hidden: Set<string>;
}

export default function YearlyReturnsChart({ data, series, hidden }: Props) {
  const shown = useMemo(() => visibleSeries(series, hidden), [series, hidden]);
  const chartData = useMemo(
    () => buildYearlyReturnsChartData(data, shown),
    [data, shown],
  );

  if (chartData.length < 1 || shown.length === 0) return null;

  return (
    <div className={styles.card}>
      <div className={styles.title}>Rendements annuels (%)</div>
      <div className={styles.sub}>Variation % de chaque année calendaire sur la plage affichée</div>
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis dataKey="year" stroke="#5c6d85" fontSize={11} tickLine={false} />
            <YAxis
              tickFormatter={(v) => `${v}%`}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={48}
            />
            <Tooltip
              formatter={(v: number) => fmtPct(v)}
              labelFormatter={(y) => `Année ${y}`}
            />
            <Legend />
            {shown.map((s) => (
              <Bar key={s.id} dataKey={s.id} name={s.label} fill={s.color} radius={[3, 3, 0, 0]} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
