/** 1 536 000 -> "1,5 Mo" (decimal units, like the operating system and the Supabase dashboard). */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return `${Math.round(n)} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let v = n / 1000;
  let i = 0;
  while (Math.abs(v) >= 1000 && i < units.length - 1) {
    v /= 1000;
    i += 1;
  }
  const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
  return `${v.toFixed(digits).replace('.', ',')} ${units[i]}`;
}

/** Share in percent, 0 when the total is unknown or zero. */
export function pct(part: number, total: number | null | undefined): number {
  if (!total || total <= 0 || !Number.isFinite(part)) return 0;
  return (part / total) * 100;
}

export function fmtPct(p: number): string {
  if (p > 0 && p < 0.1) return '<0,1 %';
  return `${p.toFixed(p >= 10 ? 0 : 1).replace('.', ',')} %`;
}

/** "il y a 3 j", for last-seen columns. */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'jamais';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return "à l'instant";
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return `il y a ${Math.round(s / 86400)} j`;
}
