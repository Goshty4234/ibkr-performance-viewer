import type { Metadata } from 'next';
import AccountsHome from '@/components/AccountsHome';

export const metadata: Metadata = { title: 'Comptes IBKR · Momentum Backtester' };

export default function IbkrHomePage() {
  return <AccountsHome />;
}
