'use client';

import { useEffect, useState } from 'react';
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
  noDataInRange?: boolean;
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

export default function PerformanceChart({ data, benchmark, loading, hasStatements, noDataInRange }: Props) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const showChart = mounted && !loading && hasStatements && !noDataInRange && data.length > 0;

  return (
    <div className={styles.card}>
      <div className={styles.title}>Performance relative (0% au début de la plage)</div>
      <div className={styles.sub}>TWRR chaîné · Forme journalière dérivée du CSV (trades, dividendes, frais)</div>

      {loading && <p className={styles.empty}>Chargement du benchmark…</p>}

      {!loading && !hasStatements && (
        <p className={styles.empty}>
          Importez un Activity Statement IBKR pour commencer.<br />
          <small>Statements mensuels recommandés pour plus de détail.</small>
        </p>
      )}

      {!loading && hasStatements && noDataInRange && (
        <p className={styles.empty}>
          Aucune donnée pour la plage sélectionnée.<br />
          <small>Essayez une autre période ou importez un CSV couvrant ces dates.</small>
        </p>
      )}

      {!loading && hasStatements && !noDataInRange && data.length === 0 && (
        <p className={styles.empty}>Aucune donnée pour cette plage de dates.</p>
      )}

      {showChart && (
        <div className={styles.chart}>
          <ResponsiveContainer width="100%" height={360}>
            <LineChart key={benchmark} data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(v) => format(new Date(v + 'T12:00:00'), 'MMM yy', { locale: fr })}
                stroke="#5c6d85"
                fontSize={11}
                tickLine={false}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                stroke="#5c6d85"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                width={48}
              />
              <Tooltip content={<TooltipContent />} />
              <Line type="monotone" dataKey="portfolio" name="Portefeuille" stroke="#4d8dff" strokeWidth={2.5} dot={data.length <= 24} activeDot={{ r: 5, strokeWidth: 0 }} />
              <Line type="monotone" dataKey="benchmark" name={BENCHMARK_LABELS[benchmark]} stroke="#ffb020" strokeWidth={2} dot={false} strokeDasharray="6 4" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
