'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from 'recharts';
import { formatChartTooltipDate, formatShortDateRange } from '@/lib/dates';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { seriesGapKey, visibleSeries } from '@/lib/chart-series';
import {
  type ChartBrushSelection,
  CHART_PLOT_MARGIN,
  CHART_YAXIS_WIDTH,
  clientXToDataIndex,
  dataIndexToPlotX,
  PAINT_POINTS,
  rangeTotalReturn,
  sampleEvenExtremes,
} from '@/lib/chart-range';
import { fitHoverTip, leavingChartPair, publishChartHover, subscribeChartHover } from '@/lib/chart-hover';
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
  hint?: string;
  title?: string;
  /** Offer a log scale (growth multiple 1 + r, labelled in %). */
  logToggle?: boolean;
}

const LOG_FLOOR = 1e-4;
const toGrowth = (pct: number) => Math.max(1 + pct / 100, LOG_FLOOR);
const fromGrowth = (g: number) => (g - 1) * 100;

const MAX_LOG_TICKS = 7;

/** Geometric ticks through 0 % (growth 1): ×2, ×4, ×10 or ×100 so at most ~7 fit; linear for narrow ranges. */
function logTicks(lo: number, hi: number): number[] {
  const span = Math.log(hi / lo);
  const factor = [2, 4, 10, 100].find((f) => span / Math.log(f) <= MAX_LOG_TICKS) ?? 1000;
  const ticks: number[] = [];
  for (let g = factor ** Math.floor(Math.log(lo) / Math.log(factor)); g <= hi * 1.0001; g *= factor) {
    if (g >= lo) ticks.push(g);
  }
  if (ticks.length >= 3) return ticks;
  const step = (hi - lo) / 4;
  return Array.from({ length: 5 }, (_, i) => lo + step * i);
}

function logTickLabel(g: number): string {
  const pct = fromGrowth(g);
  if (Math.abs(pct) >= 1e6) return `${Math.round(pct / 1e6)}M%`;
  if (Math.abs(pct) >= 1e4) return `${Math.round(pct / 1e3)}k%`;
  return `${Math.round(pct)}%`;
}

interface DragState {
  anchor: number;
  current: number;
  dragging: boolean;
}

function PerformancePointer({
  plotRef,
  length,
  log,
  shown,
  chartData,
}: {
  plotRef: React.RefObject<HTMLDivElement | null>;
  length: number;
  log: boolean;
  shown: ChartSeriesDef[];
  chartData: MultiSeriesChartPoint[];
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
      el.className = 'mono';
      el.style.color = s.color;
      rows.appendChild(el);
      return el;
    });
    const place = (hover: { index: number } | null) => {
      const line = lineRef.current;
      const tip = tipRef.current;
      const node = plotRef.current;
      if (!line || !tip || !node) return;
      if (!hover || hover.index >= length) {
        line.hidden = true;
        tip.hidden = true;
        return;
      }
      const left = dataIndexToPlotX(hover.index, node.getBoundingClientRect(), length);
      const flip = left > node.clientWidth * 0.62;
      line.hidden = false;
      tip.hidden = false;
      line.style.left = `${left}px`;
      tip.style.left = `${left}px`;
      tip.style.transform = flip ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
      if (dateRef.current) dateRef.current.textContent = formatChartTooltipDate(chartData[hover.index]?.date);
      const row = chartData[hover.index];
      for (let i = 0; i < shown.length; i++) {
        const raw = row?.[`${shown[i].id}_main`];
        const el = nodes[i];
        if (typeof raw !== 'number') { el.hidden = true; continue; }
        el.hidden = false;
        el.textContent = `${shown[i].label}: ${fmtPct(log ? fromGrowth(raw) : raw)}`;
      }
      fitHoverTip(tip, node, 12, 'primary');
    };
    place(null);
    return subscribeChartHover(place);
  }, [plotRef, length, log, shown, chartData]);

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
  hint,
  title,
  logToggle,
}: Props) {
  const [mounted, setMounted] = useState(false);
  const [logScale, setLogScale] = useState(false);
  const log = Boolean(logToggle && logScale);
  const plotRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const bubbleValueRef = useRef<HTMLDivElement>(null);
  const bubbleDatesRef = useRef<HTMLDivElement>(null);

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

  const chartData = useMemo(() => {
    return data.map((row) => {
      const r: MultiSeriesChartPoint = { ...row };
      for (const s of shown) {
        const gap = !!row[seriesGapKey(s.id)];
        const raw = row[s.id];
        const v = log && typeof raw === 'number' ? toGrowth(raw) : (raw as number);
        r[`${s.id}_main`] = gap ? null : v;
        r[`${s.id}_gap`] = gap ? v : null;
      }
      return r;
    });
  }, [data, shown, log]);

  const logAxis = useMemo(() => {
    if (!log) return null;
    let lo = Infinity;
    let hi = -Infinity;
    for (const row of chartData) {
      for (const s of shown) {
        for (const k of [`${s.id}_main`, `${s.id}_gap`]) {
          const v = row[k];
          if (typeof v === 'number' && Number.isFinite(v)) {
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
      }
    }
    if (!Number.isFinite(lo)) return null;
    const domain: [number, number] = [lo * 0.95, hi * 1.05];
    return { domain, ticks: logTicks(domain[0], domain[1]) };
  }, [log, chartData, shown]);

  const highlightSeries = useMemo(
    () => shown.find((s) => s.kind === 'primary') ?? shown[0] ?? null,
    [shown],
  );
  const paintData = useMemo(
    () => sampleEvenExtremes(chartData, shown.map((s) => `${s.id}_main`), PAINT_POINTS),
    [chartData, shown],
  );

  const paintBrush = useCallback((lo: number, hi: number) => {
    const band = bandRef.current;
    const bubble = bubbleRef.current;
    const node = plotRef.current;
    if (!band || !bubble || !node) return;
    if (hi - lo < 1 || !data[lo] || !data[hi]) {
      band.hidden = true;
      bubble.hidden = true;
      return;
    }
    const rect = node.getBoundingClientRect();
    const x1 = dataIndexToPlotX(lo, rect, data.length);
    const x2 = dataIndexToPlotX(hi, rect, data.length);
    const ret = highlightSeries
      ? rangeTotalReturn((data[lo][highlightSeries.id] as number) ?? 0, (data[hi][highlightSeries.id] as number) ?? 0)
      : null;
    band.hidden = false;
    band.style.left = `${Math.min(x1, x2)}px`;
    band.style.width = `${Math.max(Math.abs(x2 - x1), 1)}px`;
    band.style.background = ret != null && ret >= 0 ? 'rgba(45, 212, 168, 0.22)' : 'rgba(255, 107, 122, 0.22)';
    if (ret == null || !bubbleValueRef.current || !bubbleDatesRef.current) {
      bubble.hidden = true;
      return;
    }
    bubble.hidden = false;
    bubble.style.left = `${(x1 + x2) / 2}px`;
    bubbleValueRef.current.textContent = `${ret >= 0 ? '▲' : '▼'} ${fmtPct(ret)}`;
    bubbleValueRef.current.className = `mono ${ret >= 0 ? 'positive' : 'negative'}`;
    bubbleDatesRef.current.textContent = formatShortDateRange(data[lo].date, data[hi].date);
  }, [data, highlightSeries]);

  useEffect(() => {
    if (dragRef.current?.dragging) return;
    if (!brush) {
      if (bandRef.current) bandRef.current.hidden = true;
      if (bubbleRef.current) bubbleRef.current.hidden = true;
      return;
    }
    paintBrush(brush.startIdx, brush.endIdx);
  }, [brush, paintBrush]);

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
    dragRef.current = { anchor: idx, current: idx, dragging: false };
  };

  const onPlotMouseMove = (e: React.MouseEvent) => {
    const idx = resolveIndex(e.clientX);
    publishChartHover({ index: idx, source: 'performance' });
    const drag = dragRef.current;
    if (!drag || e.buttons !== 1) return;
    const lo = Math.min(drag.anchor, idx);
    const hi = Math.max(drag.anchor, idx);
    drag.current = idx;
    drag.dragging = drag.dragging || hi - lo >= DRAG_THRESHOLD_IDX;
    if (!drag.dragging) return;
    plotRef.current?.classList.add(styles.plotDragging);
    paintBrush(lo, hi);
  };

  const onPlotMouseUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    plotRef.current?.classList.remove(styles.plotDragging);
    if (!drag) return;
    if (drag.dragging) commitBrush(drag.anchor, drag.current);
    else if (brush) onBrushChange(null);
  };

  const onPlotMouseLeave = (e: React.MouseEvent) => {
    if (leavingChartPair(e.relatedTarget)) publishChartHover(null);
    const drag = dragRef.current;
    dragRef.current = null;
    plotRef.current?.classList.remove(styles.plotDragging);
    if (drag?.dragging) commitBrush(drag.anchor, drag.current);
  };

  return (
    <div className={`${styles.card} ${stacked ? styles.stackTop : ''}`}>
      {logToggle && (
        <div className={styles.scaleToggle} title="Échelle log : des écarts de rendement égaux en % ont la même hauteur, utile quand les portfolios divergent beaucoup">
          <button type="button" className={logScale ? styles.scaleOn : ''} onClick={() => setLogScale(true)}>Log</button>
          <button type="button" className={!logScale ? styles.scaleOn : ''} onClick={() => setLogScale(false)}>Linéaire</button>
        </div>
      )}
      <div className={styles.title}>{title ?? 'Performance relative (0% au début de la plage)'}</div>
      <div className={styles.sub}>
        {subtitle ?? 'TWRR chaîné · Forme journalière dérivée du CSV (trades, dividendes, frais)'}
      </div>

      {showChart && (
        <p className={styles.dragHint}>
          {hint ?? 'Cliquez-glissez pour mesurer une sous-période · simple clic pour effacer · Échap pour effacer. Traits gris pointillés = trou entre imports CSV.'}
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
            className={styles.plotWrap}
            data-chart-hover=""
            ref={plotRef}
            onMouseDown={onPlotMouseDown}
            onMouseMove={onPlotMouseMove}
            onMouseUp={onPlotMouseUp}
            onMouseLeave={onPlotMouseLeave}
          >
            <ResponsiveContainer width="100%" height={360}>
              <LineChart
                data={paintData}
                margin={CHART_PLOT_MARGIN}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                {/* Hidden date axis (takes no space; the dates are shown by the Drawdown chart below).
                    Without it Recharts only builds an implicit index axis when at least one Line is
                    drawn: with every series hidden the selection overlay then crashed ("Could not
                    find xAxis by id 0"), and its date-based x1/x2 never resolved on an index axis. */}
                <XAxis dataKey="date" hide />
                {logAxis ? (
                  <YAxis
                    scale="log"
                    domain={logAxis.domain}
                    ticks={logAxis.ticks}
                    allowDataOverflow
                    tickFormatter={logTickLabel}
                    interval={0}
                    stroke="#5c6d85"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={CHART_YAXIS_WIDTH}
                  />
                ) : (
                  <YAxis
                    tickFormatter={(v) => `${v}%`}
                    stroke="#5c6d85"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                    width={CHART_YAXIS_WIDTH}
                  />
                )}
                {shown.map((s) => (
                  <Line
                    key={`${s.id}_main`}
                    type="linear"
                    dataKey={`${s.id}_main`}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={s.kind === 'primary' ? 2.5 : 2}
                    dot={paintData.length <= 24 && s.kind === 'primary'}
                    activeDot={false}
                    strokeDasharray={s.strokeDasharray}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
                {shown.map((s) => (
                  <Line
                    key={`${s.id}_gap`}
                    type="linear"
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

            <div ref={bandRef} className={styles.brushBand} hidden />
            <div ref={bubbleRef} className={styles.rangeBubble} hidden>
              <div ref={bubbleValueRef} className="mono" />
              <div ref={bubbleDatesRef} className={styles.rangeBubbleDates} />
            </div>
            <PerformancePointer plotRef={plotRef} length={chartData.length} log={log} shown={shown} chartData={chartData} />
          </div>
          <ChartLegend series={series} hidden={hidden} onToggle={onToggleSeries} />
        </>
      )}
    </div>
  );
}
