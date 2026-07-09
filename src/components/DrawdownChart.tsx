'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { formatChartTooltipDate } from '@/lib/dates';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { visibleSeries } from '@/lib/chart-series';
import {
  CHART_PLOT_MARGIN_BOTTOM,
  CHART_SYNC_ID,
  CHART_YAXIS_WIDTH,
} from '@/lib/chart-range';
import { computeDrawdownSeries, fmtPct, getMaxDrawdown } from '@/lib/performance';
import styles from './DrawdownChart.module.css';

interface Props {
  series: ChartSeriesDef[];
  data: MultiSeriesChartPoint[];
  hidden: Set<string>;
  loading: boolean;
  show: boolean;
  stacked?: boolean;
}

function TooltipContent({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string; color: string; payload?: { date?: string } }>;
  label?: unknown;
  series: ChartSeriesDef[];
}) {
  if (!active || !payload?.length) return null;
  const labelById = new Map(series.map((s) => [s.id, s.label]));
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>
        {formatChartTooltipDate(label, payload)}
      </div>
      {payload.map((e) => (
        <div key={e.dataKey} style={{ color: e.color }} className="mono negative">
          {labelById.get(e.dataKey) ?? e.dataKey}: {fmtPct(e.value)}
        </div>
      ))}
    </div>
  );
}

export default function DrawdownChart({
  series,
  data,
  hidden,
  loading,
  show,
  stacked,
}: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const shown = useMemo(() => visibleSeries(series, hidden), [series, hidden]);

  const drawdownData = useMemo(() => {
    if (!data.length) return [];
    const ddById = new Map<string, number[]>();
    for (const s of series) {
      const cum = data.map((p) => ({
        date: p.date,
        portfolio: (p[s.id] as number) ?? 0,
      }));
      ddById.set(s.id, computeDrawdownSeries(cum).map((p) => p.drawdown));
    }
    return data.map((p, i) => {
      const row: Record<string, number | string> = { date: p.date };
      for (const s of series) {
        row[s.id] = ddById.get(s.id)?.[i] ?? 0;
      }
      return row;
    });
  }, [data, series]);

  const maxBySeries = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of shown) {
      const vals = drawdownData.map((p) => (p[s.id] as number) ?? 0);
      map.set(s.id, getMaxDrawdown(vals.map((drawdown, i) => ({
        date: drawdownData[i].date as string,
        drawdown,
      }))));
    }
    return map;
  }, [drawdownData, shown]);

  const yMin = useMemo(() => {
    if (!drawdownData.length || !shown.length) return -10;
    let m = 0;
    for (const row of drawdownData) {
      for (const s of shown) {
        const v = row[s.id] as number;
        if (v < m) m = v;
      }
    }
    return Math.floor(m * 1.1);
  }, [drawdownData, shown]);

  if (!mounted || !show || loading || drawdownData.length < 2 || shown.length === 0) return null;

  return (
    <div className={`${styles.card} ${stacked ? styles.stackBottom : ''}`}>
      <div className={styles.title}>Drawdown</div>
      <div className={styles.sub}>
        Baisse depuis le dernier pic · Max sur la plage :{' '}
        {shown.map((s, i) => (
          <span key={s.id}>
            {i > 0 && ' · '}
            <span style={{ color: s.color }}>{s.label}</span>{' '}
            <span className="mono negative">{fmtPct(maxBySeries.get(s.id) ?? 0)}</span>
          </span>
        ))}
      </div>
      <div className={styles.chart}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart
            data={drawdownData}
            margin={CHART_PLOT_MARGIN_BOTTOM}
            syncId={CHART_SYNC_ID}
            syncMethod="value"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={(v) => format(new Date(v + 'T12:00:00'), 'MMM yy', { locale: fr })}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              height={28}
            />
            <YAxis
              domain={[yMin, 0]}
              tickFormatter={(v) => `${v}%`}
              stroke="#5c6d85"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={CHART_YAXIS_WIDTH}
            />
            <Tooltip content={<TooltipContent series={series} />} />
            {shown.map((s) => (
              <Line
                key={s.id}
                type="monotone"
                dataKey={s.id}
                name={s.label}
                stroke={s.color}
                strokeWidth={s.kind === 'primary' ? 2.5 : 2}
                dot={drawdownData.length <= 24 && s.kind === 'primary'}
                activeDot={{ r: 4, strokeWidth: 0 }}
                strokeDasharray={s.strokeDasharray}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
