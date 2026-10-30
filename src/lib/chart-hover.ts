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

const TIP_PAD = 8;

let pairedTip: { top: number; bottom: number } | null = null;

/** Sticky tab bars near the top of the window, so a legend is not hidden behind them. */
function occupiedTop(): number {
  let limit = TIP_PAD;
  document.querySelectorAll('[role="tablist"]').forEach((el) => {
    if (!(el instanceof HTMLElement)) return;
    const box = el.getBoundingClientRect();
    if (box.bottom > limit && box.top < 180) limit = box.bottom + TIP_PAD;
  });
  return limit;
}

/**
 * Keep a hover legend inside the window. A list longer than the window
 * scrolls instead of running off the bottom of the page. The drawdown legend
 * moves to the other side of the cursor when the two lists would cover each other.
 */
export function fitHoverTip(
  tip: HTMLElement,
  plot: HTMLElement,
  preferredTop: number,
  kind: 'primary' | 'secondary' = 'primary',
) {
  const minTop = occupiedTop();
  const viewBottom = window.innerHeight - TIP_PAD;
  const plotTop = plot.getBoundingClientRect().top;
  const needed = tip.scrollHeight;
  const maxH = Math.max(120, viewBottom - minTop);
  const height = Math.min(needed, maxH);
  let viewTop = plotTop + preferredTop;
  if (viewTop + height > viewBottom) viewTop = viewBottom - height;
  if (viewTop < minTop) viewTop = minTop;
  if (
    kind === 'secondary'
    && pairedTip
    && viewTop < pairedTip.bottom - 4
    && viewTop + height > pairedTip.top + 4
  ) {
    const flipped = tip.style.transform.includes('-100%');
    tip.style.transform = flipped ? 'translateX(14px)' : 'translateX(calc(-100% - 14px))';
  }
  tip.style.top = `${viewTop - plotTop}px`;
  if (needed > height + 1) {
    tip.style.maxHeight = `${height}px`;
    tip.style.overflowY = 'auto';
    tip.style.pointerEvents = 'auto';
    tip.style.overscrollBehavior = 'contain';
  } else {
    tip.style.maxHeight = '';
    tip.style.overflowY = '';
    tip.style.pointerEvents = '';
    tip.style.overscrollBehavior = '';
  }
  if (kind === 'primary') pairedTip = { top: viewTop, bottom: viewTop + height };
}
