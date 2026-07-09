import type { PerformanceSummary, BenchmarkSymbol } from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import { fmtPct } from '@/lib/performance';
import styles from './StatsGrid.module.css';

interface Props {
  summary: PerformanceSummary;
  benchmark: BenchmarkSymbol;
  performanceSub?: string;
}

export default function StatsGrid({ summary, benchmark, performanceSub }: Props) {
  const cards = [
    { label: 'Rendement portefeuille', value: summary.portfolioReturn, sub: performanceSub ?? 'TWRR sur la plage' },
    { label: BENCHMARK_LABELS[benchmark], value: summary.benchmarkReturn, sub: 'Rendement total' },
    { label: 'Alpha', value: summary.alpha, sub: 'vs benchmark' },
    { label: 'CAGR portefeuille', value: summary.cagr, sub: `${Math.round(summary.days)} jours` },
  ];

  return (
    <div className={styles.grid}>
      {cards.map((c) => (
        <div key={c.label} className={styles.card}>
          <div className={styles.label}>{c.label}</div>
          <div className={`${styles.value} mono ${c.value >= 0 ? 'positive' : 'negative'}`}>
            {fmtPct(c.value)}
          </div>
          <div className={styles.sub}>{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
