export const dynamic = 'force-dynamic';

import type { Metadata } from 'next';
import ReportView from '@/components/backtest/report/ReportView';
import { requireUser } from '@/lib/supabase/current-user';

export const metadata: Metadata = { title: 'Rapport de backtest' };

export default async function ReportPage({ params }: { params: Promise<{ runId: string }> }) {
  await requireUser();
  const { runId } = await params;
  return <ReportView runId={runId} />;
}
