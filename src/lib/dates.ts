import { format, isValid } from 'date-fns';
import { fr } from 'date-fns/locale';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function toDate(dateStr: string): Date | null {
  const d = new Date(dateStr.includes('T') ? dateStr : `${dateStr}T12:00:00`);
  return isValid(d) ? d : null;
}

/** Date ISO depuis le label Recharts ou le point de données (payload). */
export function resolveChartTooltipDate(
  label: unknown,
  payload?: ReadonlyArray<{ payload?: { date?: unknown } }>,
): string | null {
  if (typeof label === 'string' && ISO_DATE.test(label)) return label.slice(0, 10);
  const fromPayload = payload?.[0]?.payload?.date;
  if (typeof fromPayload === 'string' && ISO_DATE.test(fromPayload)) return fromPayload.slice(0, 10);
  return null;
}

export function formatDateLabel(dateStr: string): string {
  const d = toDate(dateStr);
  if (!d) return dateStr;
  return format(d, 'd MMM yyyy', { locale: fr });
}

export function formatChartTooltipDate(
  label: unknown,
  payload?: ReadonlyArray<{ payload?: { date?: unknown } }>,
): string {
  const resolved = resolveChartTooltipDate(label, payload);
  return resolved ? formatDateLabel(resolved) : '';
}

export function formatShortDateRange(start: string, end: string): string {
  const s = toDate(start);
  const e = toDate(end);
  if (!s || !e) return `${start} – ${end}`;
  return `${format(s, 'EEE d MMM', { locale: fr })} – ${format(e, 'EEE d MMM', { locale: fr })}`;
}
