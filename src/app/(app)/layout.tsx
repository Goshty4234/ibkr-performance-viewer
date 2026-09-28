export const dynamic = 'force-dynamic';

import AppShell from '@/components/AppShell';
import { userOrGuest } from '@/lib/supabase/current-user';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { user, guest } = await userOrGuest();
  return <AppShell email={user?.email} guest={guest}>{children}</AppShell>;
}
