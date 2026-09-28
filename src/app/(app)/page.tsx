import type { Metadata } from 'next';
import BacktesterLoader from '@/components/backtest/BacktesterLoader';

export const metadata: Metadata = { title: 'Backtester · Momentum Backtester' };

export default function BacktesterPage() {
  return <BacktesterLoader />;
}
