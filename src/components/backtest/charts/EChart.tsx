'use client';

import { useEffect, useRef } from 'react';
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
  }, [option, notMerge]);

  return <div ref={el} className={className} style={{ width: '100%', height }} />;
}
