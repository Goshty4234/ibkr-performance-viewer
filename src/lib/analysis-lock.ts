const STORAGE_KEY = 'ibkr-global-analysis-start-lock';

/** Verrou de début d'analyse partagé entre comptes (localStorage). */
export function getGlobalAnalysisLock(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function setGlobalAnalysisLock(date: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (date) localStorage.setItem(STORAGE_KEY, date);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Date la plus récente entre verrou compte et verrou global. */
export function mergeAnalysisLocks(
  accountLock?: string | null,
  globalLock?: string | null,
): string | null {
  const locks = [accountLock, globalLock].filter(
    (d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d),
  );
  if (!locks.length) return null;
  return locks.reduce((a, b) => (a > b ? a : b));
}

/** Début effectif d'une courbe = max(plage UI, verrous du compte). */
export function effectiveSeriesStart(
  rangeStart: string,
  accountLock?: string | null,
  globalLock?: string | null,
): string {
  const lock = mergeAnalysisLocks(accountLock, globalLock);
  if (lock && lock > rangeStart) return lock;
  return rangeStart;
}
