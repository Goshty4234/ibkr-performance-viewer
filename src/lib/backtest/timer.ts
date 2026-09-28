/**
 * Next rebalance countdown: `calculate_next_rebalance_date` of the Streamlit
 * app, evaluated live in the browser's local time (market open assumed 9:30).
 * Where Python's date.replace would raise on a missing day (e.g. Jan 31 + 1
 * month) the date is clamped to the month's last day.
 */

function ymd(d: Date): [number, number, number] {
  return [d.getFullYear(), d.getMonth(), d.getDate()];
}

function makeDate(y: number, m0: number, day: number): Date {
  const yy = y + Math.floor(m0 / 12);
  const mm = ((m0 % 12) + 12) % 12;
  const last = new Date(yy, mm + 1, 0).getDate();
  return new Date(yy, mm, Math.min(day, last));
}

function addDays(d: Date, n: number): Date {
  const [y, m, day] = ymd(d);
  return new Date(y, m, day + n);
}

function parseLocal(s: string): Date {
  return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
}

export interface NextRebalance {
  date: Date;
  at: Date;
  msUntil: number;
}

export function nextRebalance(frequency: string, lastRebalance: string | null, now = new Date()): NextRebalance | null {
  if (!lastRebalance || frequency === 'none') return null;
  const last = parseLocal(lastRebalance);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = addDays(today, -1);
  const base = last >= yesterday ? addDays(yesterday, -1) : last;
  const [y, m, d] = ymd(base);
  let next: Date;
  switch (frequency) {
    case 'market_day':
    case 'calendar_day':
      next = addDays(base, 1);
      break;
    case 'week':
      next = addDays(base, 7);
      break;
    case '2weeks':
      next = addDays(base, 14);
      break;
    case 'month':
      next = makeDate(y, m + 1, d);
      break;
    case '3months':
      next = makeDate(y, m + 3, d);
      break;
    case '6months':
      next = makeDate(y, m + 6, d);
      break;
    case 'year':
      next = makeDate(y + 1, m, d);
      break;
    default:
      return null;
  }
  const at = (dt: Date) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), 9, 30);
  let when = at(next);
  for (let i = 0; when <= now && i < 10; i++) {
    const [ny, nm, nd] = ymd(next);
    if (frequency === 'market_day' || frequency === 'calendar_day') next = addDays(next, 1);
    else if (frequency === 'week') next = addDays(next, 7);
    else if (frequency === '2weeks') next = addDays(next, 14);
    else if (frequency === 'month') next = makeDate(ny, nm + 1, Math.min(nd, 28));
    else if (frequency === '3months') next = makeDate(ny, nm + 3, 1);
    else if (frequency === '6months') next = makeDate(ny, nm + 6, 1);
    else if (frequency === 'year') next = makeDate(ny + 1, nm, nd);
    when = at(next);
  }
  return { date: next, at: when, msUntil: when.getTime() - now.getTime() };
}

const PROGRESS_FREQUENCIES = new Set(['week', '2weeks', 'month', '3months', '6months', 'year']);

/** Share of the period between the last rebalance (midnight) and the next one already elapsed, 0–1. */
export function rebalanceProgress(frequency: string, lastRebalance: string, nextAt: Date, now = new Date()): number | null {
  if (!PROGRESS_FREQUENCIES.has(frequency)) return null;
  const start = parseLocal(lastRebalance).getTime();
  const total = nextAt.getTime() - start;
  if (!(total > 0)) return null;
  return Math.min(Math.max((now.getTime() - start) / total, 0), 1);
}

/** Streamlit `format_time_until`, in French. */
export function formatTimeUntil(ms: number): string {
  const total = Math.trunc(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} j, ${hours} h, ${minutes} min`;
  if (hours > 0) return `${hours} h, ${minutes} min`;
  return `${minutes} min`;
}

export const FREQUENCY_LABELS: Record<string, string> = {
  market_day: 'Chaque jour de bourse',
  calendar_day: 'Chaque jour',
  week: 'Hebdomadaire',
  '2weeks': 'Toutes les 2 semaines',
  month: 'Mensuel',
  '3months': 'Trimestriel',
  '6months': 'Semestriel',
  year: 'Annuel',
  none: 'Jamais',
};
