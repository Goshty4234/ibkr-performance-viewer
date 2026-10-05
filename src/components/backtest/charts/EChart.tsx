'use client';

import { useEffect, useRef, useState } from 'react';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { loadECharts } from './echarts-setup';

type Handler = (params: unknown, chart: ECharts) => void;

export interface EChartProps {
  option: EChartsCoreOption;
  height?: number | string;
  className?: string;
  /** Replace the whole option instead of merging (series count changed). */
  notMerge?: boolean;
  /** Charts sharing a group sync tooltips and zoom. */
  group?: string;
  onEvents?: Record<string, Handler>;
  onReady?: (chart: ECharts) => void;
  theme?: 'bt-dark' | 'bt-light';
}

/** Single canvas chart wrapper: lazy ECharts, resize observer, stable event handlers. */
export default function EChart({ option, height = 320, className, notMerge = true, group, onEvents, onReady, theme = 'bt-dark' }: EChartProps) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<ECharts | null>(null);
  // True while a zoom (slider, wheel or drag) hides part of the chart: shows the way back.
  const [zoomed, setZoomed] = useState(false);
  const latest = useRef({ option, notMerge, onEvents, onReady });
  latest.current = { option, notMerge, onEvents, onReady };

  useEffect(() => {
    let disposed = false;
    let ro: ResizeObserver | null = null;
    loadECharts().then((ec) => {
      if (disposed || !el.current) return;
      const c = ec.init(el.current, theme, { renderer: 'canvas' });
      chart.current = c;
      if (group) {
        c.group = group;
        ec.connect(group);
      }
      c.setOption(latest.current.option, true);
      for (const name of Object.keys(latest.current.onEvents ?? {})) {
        c.on(name, (params: unknown) => latest.current.onEvents?.[name]?.(params, c));
      }
      const syncZoom = () => {
        const zs = (c.getOption() as { dataZoom?: { start?: number; end?: number }[] }).dataZoom ?? [];
        setZoomed(zs.some((z) => (z.start ?? 0) > 0.05 || (z.end ?? 100) < 99.95));
      };
      c.on('datazoom', syncZoom);
      c.getZr().on('dblclick', () => {
        c.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      });
      latest.current.onReady?.(c);
      // Hidden (kept-alive) tabs report 0×0: skip so the canvas keeps its size until shown again.
      let size = `${el.current.clientWidth}x${el.current.clientHeight}`;
      ro = new ResizeObserver(() => {
        const box = el.current;
        if (!box || !box.clientWidth || !box.clientHeight) return;
        const next = `${box.clientWidth}x${box.clientHeight}`;
        if (next === size) return;
        size = next;
        c.resize();
      });
      ro.observe(el.current);
    });
    return () => {
      disposed = true;
      ro?.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, [group, theme]);

  useEffect(() => {
    chart.current?.setOption(option, { notMerge, lazyUpdate: true });
    setZoomed(false);
  }, [option, notMerge]);

  return (
    <div style={{ position: 'relative' }}>
      <div ref={el} className={className} style={{ width: '100%', height }} />
      {zoomed && (
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          title="Revenir à toute la période (double-clic sur le graphique : pareil)"
          style={{ position: 'absolute', top: 4, right: 4, zIndex: 5 }}
          onClick={() => chart.current?.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })}
        >
          ↺ Réinitialiser le zoom
        </button>
      )}
    </div>
  );
}
