export const PERIOD_PRESETS: { label: string; years: number | null }[] = [
  { label: '1 an', years: 1 },
  { label: '3 ans', years: 3 },
  { label: '5 ans', years: 5 },
  { label: '10 ans', years: 10 },
  { label: 'Tout', years: null },
];

/** Start date of a preset ending on `max`, never earlier than `min`. */
export function presetStart(max: string, min: string, years: number | null): string {
  if (years === null || !max) return min;
  const d = new Date(`${max}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  const s = d.toISOString().slice(0, 10);
  return s < min ? min : s;
}
