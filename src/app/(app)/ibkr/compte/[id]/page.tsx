import { notFound } from 'next/navigation';
import AccountWorkspace from '@/components/AccountWorkspace';
import { dbToAccount } from '@/lib/account-mapper';
import { requireUser } from '@/lib/supabase/current-user';

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ComptePage({ params }: Props) {
  const { id } = await params;
  const { supabase, user } = await requireUser();

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

  return <AccountWorkspace account={account} />;
}
