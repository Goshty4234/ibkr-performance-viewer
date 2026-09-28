import { cache } from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getUserResilient } from '@/lib/supabase/auth-resilient';

/** Authenticated user for the current request (deduplicated between layout and page). */
export const requireUser = cache(async () => {
  const supabase = await createClient();
  const auth = await getUserResilient(supabase);
  if (auth.status === 'timeout' || !auth.user) redirect('/login');
  return { supabase, user: auth.user };
});
