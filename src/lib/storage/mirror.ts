import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import { localAvailable, localDeleteIbkr, localGetIbkr, localListStatements, localPutConfigs, localPutIbkr, type LocalFileInfo } from './local-library';

/**
 * Copies to the local folder what lives online, so the folder is a complete copy of the account:
 * the IBKR statements as imported (raw CSV) and a backup of the saved configurations. Silent
 * no-ops when no engine runs on this PC; failures never reach the person.
 */

export async function mirrorIbkrFile(file: File, text?: string): Promise<void> {
  if (isGuest() || !localAvailable()) return;
  try {
    const { data: { user } } = await createClient().auth.getUser();
    if (user) await localPutIbkr(user.id, file.name, text ?? file);
  } catch {
    /* mirror only */
  }
}

async function sessionUid(): Promise<string | null> {
  if (isGuest() || !localAvailable()) return null;
  try {
    const { data: { session } } = await createClient().auth.getSession();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** The statements (CSV) kept in the local folder, oldest first; empty when no local engine answers. */
export async function listLocalStatements(): Promise<LocalFileInfo[]> {
  const uid = await sessionUid();
  return uid ? localListStatements(uid) : [];
}

/** One local statement as a File, ready for the normal import. */
export async function readLocalStatement(name: string): Promise<File | null> {
  const uid = await sessionUid();
  if (!uid) return null;
  const blob = await localGetIbkr(uid, name);
  return blob ? new File([blob], name, { type: 'text/csv' }) : null;
}

/** An account deleted by its owner also loses its local data copy (the raw statements stay: they are the person's files). */
export async function removeAccountDataLocal(accountId: string): Promise<void> {
  const uid = await sessionUid();
  if (uid) await localDeleteIbkr(uid, accountFile(accountId));
  lastWritten.delete(accountId);
}

let accountTimer: ReturnType<typeof setTimeout> | null = null;
const lastWritten = new Map<string, string>();

const accountFile = (accountId: string) => `_donnees-compte-${accountId}.json`;

/** What the local copy of an account holds (null when there is none or no local engine answers). */
export async function readAccountDataLocal<T = Record<string, unknown>>(accountId: string): Promise<T | null> {
  if (isGuest() || !localAvailable()) return null;
  try {
    const { data: { session } } = await createClient().auth.getSession();
    if (!session?.user) return null;
    const blob = await localGetIbkr(session.user.id, accountFile(accountId));
    return blob ? (JSON.parse(await blob.text()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Copies to the local folder what the site extracted from the CSVs of one IBKR account (NAV, TWR, flows,
 * positions, trades), next to the raw statements. Written a moment after the last change; a silent no-op
 * when no engine runs on this PC.
 */
export function mirrorAccountDataSoon(accountId: string, build: () => unknown, delayMs = 2500): void {
  if (typeof window === 'undefined') return;
  if (accountTimer) clearTimeout(accountTimer);
  accountTimer = setTimeout(() => {
    accountTimer = null;
    void (async () => {
      if (isGuest() || !localAvailable()) return;
      try {
        const { data: { user } } = await createClient().auth.getUser();
        if (!user) return;
        const body = JSON.stringify({ accountId, ...(build() as object) });
        if (lastWritten.get(accountId) === body) return; // unchanged: no need to rewrite the file
        const ok = await localPutIbkr(user.id, accountFile(accountId), JSON.stringify({ version: 1, saved_at: new Date().toISOString(), ...JSON.parse(body) }));
        if (ok) lastWritten.set(accountId, body);
      } catch {
        /* mirror only */
      }
    })();
  }, delayMs);
}

let timer: ReturnType<typeof setTimeout> | null = null;

async function writeConfigs(): Promise<void> {
  if (isGuest() || !localAvailable()) return;
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const [saved, settings] = await Promise.all([
      supabase.from('backtest_portfolios').select('id,name,folder,config,created_at,updated_at').order('folder').order('name'),
      supabase.from('user_settings').select('default_benchmark,backtest_workspace,allocation_values').maybeSingle(),
    ]);
    if (saved.error) return;
    await localPutConfigs(
      user.id,
      JSON.stringify({ version: 1, saved_at: new Date().toISOString(), portfolios: saved.data ?? [], settings: settings.data ?? null }),
    );
  } catch {
    /* mirror only */
  }
}

/** Refreshes the configuration backup shortly after a change (changes in a burst write once). */
export function mirrorConfigsSoon(delayMs = 4000): void {
  if (typeof window === 'undefined') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void writeConfigs();
  }, delayMs);
}
