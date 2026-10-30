'use client';

import { useEffect, useState } from 'react';

/** Curseur partagé entre la performance et le drawdown, indexé sur chaque jour simulé. */
export interface ChartHover {
  index: number;
  source: 'performance' | 'drawdown';
}

let current: ChartHover | null = null;
const listeners = new Set<(hover: ChartHover | null) => void>();

export function publishChartHover(hover: ChartHover | null) {
  current = hover;
  listeners.forEach((fn) => fn(hover));
}

export function useChartHover(): ChartHover | null {
  const [hover, setHover] = useState<ChartHover | null>(current);
  useEffect(() => {
    listeners.add(setHover);
    return () => {
      listeners.delete(setHover);
    };
  }, []);
  return hover;
}
