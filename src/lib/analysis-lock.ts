/** Verrou de début d'analyse du compte (Supabase `accounts.analysis_start_lock`). */
export function effectiveSeriesStart(
  rangeStart: string,
  accountLock?: string | null,
): string {
  const lock = accountLock?.trim();
  if (lock && /^\d{4}-\d{2}-\d{2}$/.test(lock) && lock > rangeStart) return lock;
  return rangeStart;
}
