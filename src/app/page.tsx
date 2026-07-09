export const dynamic = 'force-dynamic';

import { createClient } from '@/lib/supabase/server';
import { getUserResilient } from '@/lib/supabase/auth-resilient';
import { redirect } from 'next/navigation';
import AppShell from '@/components/AppShell';
import AccountsHome from '@/components/AccountsHome';

export default async function HomePage() {
  const supabase = await createClient();
  const auth = await getUserResilient(supabase);
  if (auth.status === 'timeout' || !auth.user) redirect('/login');

  const user = auth.user;

  return (
    <AppShell email={user.email}>
      <AccountsHome />
    </AppShell>
  );
}
