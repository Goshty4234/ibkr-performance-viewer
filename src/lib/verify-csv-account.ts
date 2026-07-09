import type { SupabaseClient } from '@supabase/supabase-js';
import { isPendingIbkrId } from './account-mapper';
import {
  hashIbkrAccountIdForStorage,
  isHashedIbkrId,
  matchesIbkrAccountId,
} from './privacy';

type VerifyResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * Vérifie que le CSV correspond au compte workspace et lie le hash au 1er import.
 * L'ID IBKR en clair n'est jamais persisté.
 */
export async function verifyCsvAccountForPortfolio(
  supabase: SupabaseClient,
  userId: string,
  portfolioAccountId: string,
  csvAccountId: string,
): Promise<VerifyResult> {
  const raw = csvAccountId?.trim();
  if (!raw) {
    return { ok: false, status: 400, error: 'Compte IBKR introuvable dans le fichier' };
  }

  const { data: account, error } = await supabase
    .from('accounts')
    .select('id, ibkr_account_id')
    .eq('id', portfolioAccountId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !account) {
    return { ok: false, status: 404, error: 'Compte introuvable' };
  }

  const stored = account.ibkr_account_id as string;

  if (isPendingIbkrId(stored)) {
    const hashed = hashIbkrAccountIdForStorage(raw, userId)!;
    const { error: upErr } = await supabase
      .from('accounts')
      .update({ ibkr_account_id: hashed, updated_at: new Date().toISOString() })
      .eq('id', portfolioAccountId)
      .eq('user_id', userId);
    if (upErr) return { ok: false, status: 500, error: upErr.message };
    return { ok: true };
  }

  if (!matchesIbkrAccountId(raw, stored, userId)) {
    return {
      ok: false,
      status: 400,
      error: 'Ce fichier ne correspond pas à ce compte. Importez-le sur le bon compte workspace.',
    };
  }

  if (!isHashedIbkrId(stored)) {
    const hashed = hashIbkrAccountIdForStorage(raw, userId)!;
    await supabase
      .from('accounts')
      .update({ ibkr_account_id: hashed, updated_at: new Date().toISOString() })
      .eq('id', portfolioAccountId)
      .eq('user_id', userId);
  }

  return { ok: true };
}
