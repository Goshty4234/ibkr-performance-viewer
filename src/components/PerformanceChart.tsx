'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  YAxis,
} from 'recharts';
import { formatChartTooltipDate, formatShortDateRange } from '@/lib/dates';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { seriesGapKey, visibleSeries } from '@/lib/chart-series';
import {
  type ChartBrushSelection,
  CHART_PLOT_MARGIN,
  CHART_SYNC_ID,
  CHART_YAXIS_WIDTH,
  clientXToDataIndex,
  dataIndexToPlotX,
  rangeTotalReturn,
} from '@/lib/chart-range';
import { fmtPct } from '@/lib/performance';
import ChartLegend from './ChartLegend';
import styles from './PerformanceChart.module.css';

const GAP_STROKE = '#6b7a94';
const DRAG_THRESHOLD_IDX = 1;

interface Props {
  series: ChartSeriesDef[];
  data: MultiSeriesChartPoint[];
  hidden: Set<string>;
  onToggleSeries: (seriesId: string) => void;
  brush: ChartBrushSelection | null;
  onBrushChange: (brush: ChartBrushSelection | null) => void;
  loading: boolean;
  hasStatements: boolean;
  noDataInRange?: boolean;
  subtitle?: string;
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
  const seen = new Set<string>();
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>
        {formatChartTooltipDate(label, payload)}
      </div>
      {payload
        .filter((e) => {
          const base = e.dataKey.replace(/_(main|gap)$/, '');
          if (e.dataKey.endsWith('_main') || e.dataKey.endsWith('_gap')) {
            if (e.value == null || seen.has(base)) return false;
            seen.add(base);
            return true;
          }
          return true;
        })
        .map((e) => {
          const baseKey = e.dataKey.replace(/_(main|gap)$/, '');
          return (
            <div key={e.dataKey} style={{ color: e.color }} className="mono">
              {labelById.get(baseKey) ?? baseKey}: {fmtPct(e.value)}
            </div>
          );
        })}
    </div>
  );
}

interface DragState {
  anchor: number;
  current: number;
  dragging: boolean;
}

export default function PerformanceChart({
  series,
  data,
  hidden,
  onToggleSeries,
  brush,
  onBrushChange,
  loading,
  hasStatements,
  noDataInRange,
  subtitle,
  stacked,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [drag, setDrag] = useState<DragState | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onBrushChange(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBrushChange]);

  const shown = useMemo(() => visibleSeries(series, hidden), [series, hidden]);
  const showChart = mounted && !loading && hasStatements && !noDataInRange && data.length > 0;

  const liveSelection = useMemo((): ChartBrushSelection | null => {
    if (drag?.dragging && data.length) {
      const lo = Math.min(drag.anchor, drag.current);
      const hi = Math.max(drag.anchor, drag.current);
      if (hi - lo < 1 || !data[lo] || !data[hi]) return null;
      return {
        startIdx: lo,
        endIdx: hi,
        startDate: data[lo].date,
        endDate: data[hi].date,
      };
    }
    return brush;
  }, [drag, brush, data]);

  const chartData = useMemo(() => {
    return data.map((row) => {
      const r: MultiSeriesChartPoint = { ...row };
      for (const s of shown) {
        const gap = !!row[seriesGapKey(s.id)];
        const v = row[s.id] as number;
        r[`${s.id}_main`] = gap ? null : v;
        r[`${s.id}_gap`] = gap ? v : null;
      }
      return r;
    });
  }, [data, shown]);

  const highlightSeries = useMemo(
    () => shown.find((s) => s.kind === 'primary') ?? shown[0] ?? null,
    [shown],
  );

  const selectionReturn = useMemo(() => {
    if (!liveSelection || !highlightSeries || !data.length) return null;
    const start = data[liveSelection.startIdx];
    const end = data[liveSelection.endIdx];
    if (!start || !end) return null;
    return rangeTotalReturn(
      (start[highlightSeries.id] as number) ?? 0,
      (end[highlightSeries.id] as number) ?? 0,
    );
  }, [liveSelection, highlightSeries, data]);

  const bubbleLeft = (() => {
    if (!liveSelection || !plotRef.current) return null;
    const rect = plotRef.current.getBoundingClientRect();
    const mid = (liveSelection.startIdx + liveSelection.endIdx) / 2;
    return dataIndexToPlotX(mid, rect, data.length);
  })();

  const resolveIndex = useCallback((clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return clientXToDataIndex(clientX, rect, data.length);
  }, [data.length]);

  const commitBrush = useCallback((startIdx: number, endIdx: number) => {
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    if (hi - lo < 1 || !data[lo] || !data[hi]) {
      onBrushChange(null);
      return;
    }
    onBrushChange({
      startIdx: lo,
      endIdx: hi,
      startDate: data[lo].date,
      endDate: data[hi].date,
    });
  }, [data, onBrushChange]);

  const onPlotMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const idx = resolveIndex(e.clientX);
    setDrag({ anchor: idx, current: idx, dragging: false });
  };

  const onPlotMouseMove = (e: React.MouseEvent) => {
    if (!drag || e.buttons !== 1) return;
    const idx = resolveIndex(e.clientX);
    const lo = Math.min(drag.anchor, idx);
    const hi = Math.max(drag.anchor, idx);
    const dragging = drag.dragging || hi - lo >= DRAG_THRESHOLD_IDX;
    setDrag({ anchor: drag.anchor, current: idx, dragging });
  };

  const onPlotMouseUp = () => {
    if (!drag) return;
    if (drag.dragging) {
      commitBrush(drag.anchor, drag.current);
    } else if (brush) {
      onBrushChange(null);
    }
    setDrag(null);
  };

  const onPlotMouseLeave = () => {
    if (drag?.dragging) {
      commitBrush(drag.anchor, drag.current);
    }
    setDrag(null);
  };

  const refArea = liveSelection && data[liveSelection.startIdx] && data[liveSelection.endIdx]
    ? {
        x1: data[liveSelection.startIdx].date,
        x2: data[liveSelection.endIdx].date,
      }
    : null;

  const areaFill =
    selectionReturn != null && selectionReturn >= 0
      ? 'rgba(45, 212, 168, 0.22)'
      : 'rgba(255, 107, 122, 0.22)';

  const dotY = (seriesId: string, date: string) => {
    const row = chartData.find((p) => p.date === date);
    const v = row?.[`${seriesId}_main`];
    return typeof v === 'number' ? v : undefined;
  };

  return (
    <div className={`${styles.card} ${stacked ? styles.stackTop : ''}`}>
      <div className={styles.title}>Performance relative (0% au début de la plage)</div>
      <div className={styles.sub}>
        {subtitle ?? 'TWRR chaîné · Forme journalière dérivée du CSV (trades, dividendes, frais)'}
      </div>

      {showChart && (
        <p className={styles.dragHint}>
          Cliquez-glissez pour mesurer une sous-période · simple clic pour effacer · Échap pour effacer.
          Traits gris pointillés = trou entre imports CSV.
        </p>
      )}

      {loading && <p className={styles.empty}>Chargement des courbes…</p>}

      {!loading && !hasStatements && (
        <p className={styles.empty}>
          Importez un Activity Statement IBKR pour commencer.<br />
          <small>Statements mensuels recommandés pour plus de détail.</small>
        </p>
      )}

      {!loading && hasStatements && noDataInRange && (
        <p className={styles.empty}>
          Aucune donnée pour la plage sélectionnée.<br />
          <small>Essayez une autre période ou importez un CSV couvrant ces dates.</small>
        </p>
      )}

      {!loading && hasStatements && !noDataInRange && data.length === 0 && (
        <p className={styles.empty}>Aucune donnée pour cette plage de dates.</p>
      )}

      {showChart && (
        <>
          <div
            className={`${styles.plotWrap} ${drag?.dragging ? styles.plotDragging : ''}`}
            ref={plotRef}
            onMouseDown={onPlotMouseDown}
            onMouseMove={onPlotMouseMove}
            onMouseUp={onPlotMouseUp}
            onMouseLeave={onPlotMouseLeave}
          >
            <ResponsiveContainer width="100%" height={360}>
              <LineChart
                data={chartData}
                margin={CHART_PLOT_MARGIN}
                syncId={CHART_SYNC_ID}
                syncMethod="value"
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                <YAxis
                  tickFormatter={(v) => `${v}%`}
                  stroke="#5c6d85"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  width={CHART_YAXIS_WIDTH}
                />
                <Tooltip
                  content={<TooltipContent series={series} />}
                  cursor={{ stroke: 'rgba(255,255,255,0.35)', strokeWidth: 1 }}
                  isAnimationActive={false}
                />
                {refArea && (
                  <>
                    <ReferenceArea
                      x1={refArea.x1}
                      x2={refArea.x2}
                      fill={areaFill}
                      strokeOpacity={0}
                      ifOverflow="extendDomain"
                    />
                    <ReferenceLine
                      x={refArea.x1}
                      stroke="rgba(255,255,255,0.45)"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                    />
                    <ReferenceLine
                      x={refArea.x2}
                      stroke="rgba(255,255,255,0.45)"
                      strokeDasharray="4 4"
                      strokeWidth={1}
                    />
                  </>
                )}
                {liveSelection && highlightSeries && refArea && (() => {
                  const y1 = dotY(highlightSeries.id, refArea.x1);
                  const y2 = dotY(highlightSeries.id, refArea.x2);
                  if (y1 == null || y2 == null) return null;
                  return (
                    <>
                      <ReferenceDot
                        x={refArea.x1}
                        y={y1}
                        r={4}
                        fill={highlightSeries.color}
                        stroke="#fff"
                        strokeWidth={1.5}
                        ifOverflow="extendDomain"
                      />
                      <ReferenceDot
                        x={refArea.x2}
                        y={y2}
                        r={4}
                        fill={highlightSeries.color}
                        stroke="#fff"
                        strokeWidth={1.5}
                        ifOverflow="extendDomain"
                      />
                    </>
                  );
                })()}
                {shown.map((s) => (
                  <Line
                    key={`${s.id}_main`}
                    type="monotone"
                    dataKey={`${s.id}_main`}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={s.kind === 'primary' ? 2.5 : 2}
                    dot={data.length <= 24 && s.kind === 'primary'}
                    activeDot={{ r: 5, strokeWidth: 0 }}
                    strokeDasharray={s.strokeDasharray}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {shown.map((s) => (
                  <Line
                    key={`${s.id}_gap`}
                    type="monotone"
                    dataKey={`${s.id}_gap`}
                    stroke={GAP_STROKE}
                    strokeWidth={1.5}
                    dot={false}
                    activeDot={false}
                    strokeDasharray="4 4"
                    connectNulls
                    legendType="none"
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            {liveSelection && selectionReturn != null && bubbleLeft != null && (
              <div
                className={styles.rangeBubble}
                style={{ left: bubbleLeft }}
              >
                <div
                  className={`mono ${selectionReturn >= 0 ? 'positive' : 'negative'}`}
                >
                  {selectionReturn >= 0 ? '▲' : '▼'} {fmtPct(selectionReturn)}
                </div>
                <div className={styles.rangeBubbleDates}>
                  {formatShortDateRange(liveSelection.startDate, liveSelection.endDate)}
                </div>
              </div>
            )}
          </div>
          <ChartLegend series={series} hidden={hidden} onToggle={onToggleSeries} />
        </>
      )}
    </div>
  );
}
