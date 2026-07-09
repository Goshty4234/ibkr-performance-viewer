'use client';

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import type { BenchmarkSymbol, PerformancePoint } from '@/lib/types';
import { BENCHMARK_LABELS } from '@/lib/types';
import { fmtPct } from '@/lib/performance';
import styles from './PerformanceChart.module.css';

interface Props {
  data: PerformancePoint[];
  benchmark: BenchmarkSymbol;
  loading: boolean;
  hasStatements: boolean;
}

function TooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number; dataKey: string; color: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>
        {label ? format(new Date(label + 'T12:00:00'), 'd MMM yyyy', { locale: fr }) : ''}
      </div>
      {payload.map((e) => (
        <div key={e.dataKey} style={{ color: e.color }} className="mono">
          {e.dataKey === 'portfolio' ? 'Portefeuille' : 'Benchmark'}: {fmtPct(e.value)}
        </div>
      ))}
    </div>
  );
}

export default function PerformanceChart({ data, benchmark, loading, hasStatements }: Props) {
  return (
    <div className={styles.card}>
      <div className={styles.title}>Performance relative (0% au début de la plage)</div>
      <div className={styles.sub}>TWRR chaîné · Les flux de capitaux n&apos;affectent pas la courbe</div>

      {loading && <p className={styles.empty}>Chargement du benchmark…</p>}

      {!loading && !hasStatements && (
        <p className={styles.empty}>
          Importez un Activity Statement IBKR pour commencer.<br />
          <small>Statements mensuels recommandés pour plus de détail.</small>
        </p>
      )}

      {!loading && hasStatements && data.length === 0 && (
        <p className={styles.empty}>Aucune donnée pour cette plage de dates.</p>
      )}

      {!loading && data.length > 0 && (
        <div className={styles.chart}>
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#243040" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(v) => format(new Date(v + 'T12:00:00'), 'MMM yy', { locale: fr })}
                stroke="#7d8fa8"
                fontSize={11}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                stroke="#7d8fa8"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip content={<TooltipContent />} />
              <Line type="monotone" dataKey="portfolio" name="Portefeuille" stroke="#3d8bfd" strokeWidth={2.5} dot={data.length <= 24} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="benchmark" name={BENCHMARK_LABELS[benchmark]} stroke="#fb923c" strokeWidth={2} dot={false} strokeDasharray="6 3" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
