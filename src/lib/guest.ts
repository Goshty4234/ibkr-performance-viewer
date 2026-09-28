/**
 * Guest mode: the backtester without an account. Nothing is written to Supabase; the workspace
 * lives in sessionStorage (this tab only) so a guest session on the owner's browser never
 * overwrites, or later syncs over, the signed-in workspace kept in localStorage.
 */

export const GUEST_COOKIE = 'bt_guest';
const MAX_AGE_S = 30 * 86_400;

export function isGuest(): boolean {
  return typeof document !== 'undefined' && new RegExp(`(?:^|;\\s*)${GUEST_COOKIE}=1(?:;|$)`).test(document.cookie);
}

export function enterGuest(): void {
  document.cookie = `${GUEST_COOKIE}=1; path=/; max-age=${MAX_AGE_S}; samesite=lax`;
}

export function leaveGuest(): void {
  document.cookie = `${GUEST_COOKIE}=; path=/; max-age=0; samesite=lax`;
}

/** Browser storage for client state: per-tab and ephemeral for guests. */
export function clientStorage(): Storage {
  return isGuest() ? window.sessionStorage : window.localStorage;
}
