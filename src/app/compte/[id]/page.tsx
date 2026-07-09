export const dynamic = 'force-dynamic';

import { createClient } from '@/lib/supabase/server';
import { redirect, notFound } from 'next/navigation';
import AppShell from '@/components/AppShell';
import AccountWorkspace from '@/components/AccountWorkspace';
import { dbToAccount } from '@/lib/account-mapper';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ComptePage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data, error } = await supabase
    .from('accounts')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error || !data) notFound();

  const { count } = await supabase
    .from('statements')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('portfolio_account_id', id);

  const account = dbToAccount(data);
  account.statementCount = count ?? 0;

  return (
    <AppShell email={user.email}>
      <AccountWorkspace account={account} />
    </AppShell>
  );
}
