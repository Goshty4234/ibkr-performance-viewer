import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getUserResilient } from '@/lib/supabase/auth-resilient';
import { GUEST_COOKIE } from '@/lib/guest';

/** Authenticated user for the current request (deduplicated between layout and page). */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const auth = await getUserResilient(supabase);
  if (auth.status === 'timeout' || !auth.user) redirect('/login');
  return { supabase, user: auth.user };
});

/** Signed-in user, or a guest (backtester only, see middleware); anyone else goes to /login. */
export const userOrGuest = cache(async () => {
  const supabase = await createClient();
  const auth = await getUserResilient(supabase);
  if (auth.status === 'ok' && auth.user) return { user: auth.user, guest: false as const };
  if ((await cookies()).get(GUEST_COOKIE)?.value === '1') return { user: null, guest: true as const };
  redirect('/login');
});
