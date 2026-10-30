'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { formatChartTooltipDate } from '@/lib/dates';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { visibleSeries } from '@/lib/chart-series';
import { fitHoverTip, leavingChartPair, publishChartHover, subscribeChartHover } from '@/lib/chart-hover';
import {
  CHART_PLOT_MARGIN_BOTTOM,
  CHART_YAXIS_WIDTH,
  clientXToDataIndex,
  dataIndexToPlotX,
  PAINT_POINTS,
  sampleEvenExtremes,
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

function DrawdownPointer({
  plotRef,
  data,
  shown,
}: {
  plotRef: React.RefObject<HTMLDivElement | null>;
  data: Record<string, number | string>[];
  shown: ChartSeriesDef[];
}) {
  const lineRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const dateRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rows = rowsRef.current;
    if (!rows) return;
    rows.replaceChildren();
    const nodes = shown.map((s) => {
      const el = document.createElement('div');
      el.className = 'mono negative';
      el.style.color = s.color;
      rows.appendChild(el);
      return el;
    });
    const place = (hover: { index: number } | null) => {
      const line = lineRef.current;
      const tip = tipRef.current;
      const node = plotRef.current;
      if (!line || !tip || !node) return;
      if (!hover || hover.index >= data.length) {
        line.hidden = true;
        tip.hidden = true;
        return;
      }
      const left = dataIndexToPlotX(hover.index, node.getBoundingClientRect(), data.length);
      const flip = left > node.clientWidth * 0.62;
      line.hidden = false;
      tip.hidden = false;
      line.style.left = `${left}px`;
      tip.style.left = `${left}px`;
      tip.style.transform = flip ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
      if (dateRef.current) dateRef.current.textContent = formatChartTooltipDate(data[hover.index]?.date);
      const row = data[hover.index];
      for (let i = 0; i < shown.length; i++) {
        const v = row?.[shown[i].id];
        const el = nodes[i];
        if (typeof v !== 'number') { el.hidden = true; continue; }
        el.hidden = false;
        el.textContent = `${shown[i].label}: ${fmtPct(v)}`;
      }
      fitHoverTip(tip, node, 8, 'secondary');
    };
    place(null);
    return subscribeChartHover(place);
  }, [plotRef, data, shown]);

  return (
    <>
      <div ref={lineRef} className={styles.hoverLine} hidden />
      <div
        ref={tipRef}
        className={`${styles.tooltip} ${styles.hoverTip}`}
        hidden
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div ref={dateRef} className={styles.tooltipDate} />
        <div ref={rowsRef} />
      </div>
    </>
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
  const plotRef = useRef<HTMLDivElement>(null);
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

  const paintData = useMemo(
    () => sampleEvenExtremes(drawdownData, shown.map((s) => s.id), PAINT_POINTS),
    [drawdownData, shown],
  );

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
      <div
        className={styles.chart}
        data-chart-hover=""
        ref={plotRef}
        onMouseMove={(e) => {
          const rect = plotRef.current?.getBoundingClientRect();
          if (!rect) return;
          publishChartHover({
            index: clientXToDataIndex(e.clientX, rect, drawdownData.length),
            source: 'drawdown',
          });
        }}
        onMouseLeave={(e) => { if (leavingChartPair(e.relatedTarget)) publishChartHover(null); }}
      >
        <ResponsiveContainer width="100%" height={220}>
          <LineChart
            data={paintData}
            margin={CHART_PLOT_MARGIN_BOTTOM}
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
            {shown.map((s) => (
              <Line
                key={s.id}
                type="linear"
                dataKey={s.id}
                name={s.label}
                stroke={s.color}
                strokeWidth={s.kind === 'primary' ? 2.5 : 2}
                dot={paintData.length <= 24 && s.kind === 'primary'}
                activeDot={false}
                isAnimationActive={false}
                strokeDasharray={s.strokeDasharray}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
        <DrawdownPointer plotRef={plotRef} data={drawdownData} shown={shown} />
      </div>
    </div>
  );
}
