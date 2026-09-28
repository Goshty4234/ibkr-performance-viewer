export const dynamic = 'force-dynamic';

import AppShell from '@/components/AppShell';
import { requireUser } from '@/lib/supabase/current-user';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireUser();
  return <AppShell email={user.email}>{children}</AppShell>;
}
