'use client';

import { Fragment, useMemo } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import type { ChartSeriesDef, MultiSeriesChartPoint } from '@/lib/chart-series';
import { visibleSeries } from '@/lib/chart-series';
import {
  buildMonthlyPeriodTables,
  buildYearlyPeriodTables,
  fmtMultiple,
  heatColor,
} from '@/lib/period-performance';
import { fmtPct } from '@/lib/performance';
import styles from './PeriodTables.module.css';

interface Props {
  title: string;
  subtitle: string;
  data: MultiSeriesChartPoint[];
  series: ChartSeriesDef[];
  hidden: Set<string>;
  mode: 'yearly' | 'monthly';
}

function fmtPeriodLabel(period: string, mode: 'yearly' | 'monthly') {
  if (mode === 'yearly') return period;
  const [y, m] = period.split('-');
  return format(new Date(Number(y), Number(m) - 1, 1), 'MMM yy', { locale: fr });
}

export default function PeriodPerformanceTable({
  title,
  subtitle,
  data,
  series,
  hidden,
  mode,
}: Props) {
  const shown = useMemo(() => visibleSeries(series, hidden), [series, hidden]);

  const { periods, tables } = useMemo(() => {
    if (mode === 'yearly') {
      const r = buildYearlyPeriodTables(data, shown);
      return { periods: r.years, tables: r.tables };
    }
    const r = buildMonthlyPeriodTables(data, shown);
    return { periods: r.months, tables: r.tables };
  }, [data, shown, mode]);

  if (!periods.length || !tables.length) return null;

  return (
    <div className={styles.card}>
      <div className={styles.title}>{title}</div>
      <div className={styles.sub}>{subtitle} · premier mois/année = période partielle si la plage ne commence pas le 1er</div>
      <div className={styles.wrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{mode === 'yearly' ? 'Année' : 'Mois'}</th>
              {tables.map((t) => (
                <th key={t.seriesId} colSpan={2} className={styles.seriesHead} style={{ color: t.color }}>
                  {t.label}
                </th>
              ))}
            </tr>
            <tr>
              <th />
              {tables.map((t) => (
                <Fragment key={`${t.seriesId}-sub`}>
                  <th>% période</th>
                  <th>Cumul</th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p}>
                <td className={styles.yearCol}>{fmtPeriodLabel(p, mode)}</td>
                {tables.map((t) => {
                  const m = t.periods.get(p);
                  if (!m) {
                    return (
                      <Fragment key={`${t.seriesId}-${p}`}>
                        <td>—</td>
                        <td>—</td>
                      </Fragment>
                    );
                  }
                  return (
                    <Fragment key={`${t.seriesId}-${p}`}>
                      <td style={{ background: heatColor(m.returnPct) }}>
                        <div className={`${styles.cellPct} ${m.returnPct >= 0 ? 'positive' : 'negative'}`}>
                          {fmtPct(m.returnPct)}
                        </div>
                      </td>
                      <td>
                        <div className={styles.cellPct}>{fmtMultiple(m.multiple)}</div>
                        <div className={styles.cellSub}>{fmtPct(m.cumulativePct)} total</div>
                      </td>
                    </Fragment>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
