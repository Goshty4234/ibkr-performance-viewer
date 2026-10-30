'use client';

/** Curseur partagé entre la performance et le drawdown, indexé sur chaque jour simulé. */
export interface ChartHover {
  index: number;
  source: 'performance' | 'drawdown';
}

let current: ChartHover | null = null;
let pending: ChartHover | null = null;
let frame = 0;
const listeners = new Set<(hover: ChartHover | null) => void>();

/** Au plus une notification par image : le dernier emplacement de la souris gagne. */
export function publishChartHover(hover: ChartHover | null) {
  current = hover;
  pending = hover;
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const value = pending;
    listeners.forEach((fn) => fn(value));
  });
}

export function subscribeChartHover(fn: (hover: ChartHover | null) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** True when the pointer left both synced charts, so the shared cursor should drop. */
export function leavingChartPair(related: EventTarget | null): boolean {
  return !(related instanceof Element && related.closest('[data-chart-hover]'));
}
