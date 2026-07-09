import type { SupabaseClient, User } from '@supabase/supabase-js';

const DEFAULT_MS = 4000;

export type AuthUserResult =
  | { status: 'ok'; user: User | null }
  | { status: 'timeout' };

/** getUser avec délai max — évite de bloquer le serveur si Supabase est lent. */
export async function getUserResilient(
  supabase: SupabaseClient,
  ms = DEFAULT_MS,
): Promise<AuthUserResult> {
  try {
    const { data } = await Promise.race([
      supabase.auth.getUser(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('auth_timeout')), ms),
      ),
    ]);
    return { status: 'ok', user: data.user };
  } catch {
    return { status: 'timeout' };
  }
}
