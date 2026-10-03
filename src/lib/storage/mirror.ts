import { isGuest } from '@/lib/guest';
import { createClient } from '@/lib/supabase/client';
import { localAvailable, localPutConfigs, localPutIbkr } from './local-library';

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
