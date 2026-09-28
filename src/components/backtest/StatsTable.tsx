'use client';

import { useMemo, useState } from 'react';
import { STAT_COLUMNS, fmtMoney } from '@/lib/backtest/chart-data';
import type { PortfolioSummaryOk as PortfolioResultOk } from '@/lib/engine/types';
import styles from './Results.module.css';

type SortKey = string;

const LOWER_IS_BETTER = new Set(['Volatility', 'UlcerIndex', 'Beta']);

export default function StatsTable({
  portfolios,
  colors,
  hidden,
  onToggle,
  selected,
  onSelect,
}: {
  portfolios: PortfolioResultOk[];
  colors: Record<number, string>;
  hidden: Set<string>;
  onToggle: (id: string) => void;
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);

  const rows = useMemo(() => {
    if (!sort) return portfolios;
    const val = (p: PortfolioResultOk): number | null => {
      if (sort.key === '__name') return null;
      const v = sort.key === '__final' ? p.stats['Final Value (with)'] : p.stats[sort.key];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    return [...portfolios].sort((a, b) => {
      if (sort.key === '__name') return a.name.localeCompare(b.name) * sort.dir;
      const va = val(a);
      const vb = val(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va - vb) * sort.dir;
    });
  }, [portfolios, sort]);

  function clickSort(key: SortKey) {
    setSort((s) => {
      if (s?.key === key) return s.dir === -1 ? { key, dir: 1 } : null;
      return { key, dir: key === '__name' || LOWER_IS_BETTER.has(key) ? 1 : -1 };
    });
  }

  const arrow = (key: SortKey) => (sort?.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : '');

  return (
    <div className={`card ${styles.tableCard}`}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Statistiques</div>
          <div className={styles.cardSub}>
            Calculées par le moteur (identiques à Streamlit) · cliquer une colonne pour trier · cliquer une ligne pour voir
            ses allocations
          </div>
        </div>
      </div>
      <div className={styles.tableScroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.stickyCol} onClick={() => clickSort('__name')}>Portfolio{arrow('__name')}</th>
              {STAT_COLUMNS.map((c) => (
                <th key={c.key} title={c.title} onClick={() => clickSort(c.key)}>
                  {c.label}{arrow(c.key)}
                </th>
              ))}
              <th onClick={() => clickSort('__final')}>Valeur finale{arrow('__final')}</th>
              <th>Apports</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const id = `pf:${p.index}`;
              const off = hidden.has(id);
              return (
                <tr
                  key={p.index}
                  className={`${selected === p.index ? styles.rowSelected : ''} ${off ? styles.rowOff : ''}`}
                  onClick={() => onSelect(p.index)}
                >
                  <td className={styles.stickyCol}>
                    <span className={styles.nameCell}>
                      <button
                        type="button"
                        className={styles.swatchBtn}
                        style={{ background: off ? 'transparent' : colors[p.index], borderColor: colors[p.index] }}
                        title={off ? 'Afficher sur les graphiques' : 'Masquer des graphiques'}
                        onClick={(e) => { e.stopPropagation(); onToggle(id); }}
                      />
                      <span className={styles.nameText} title={p.name}>{p.name}</span>
                    </span>
                  </td>
                  {STAT_COLUMNS.map((c) => (
                    <td key={c.key} className={styles.num}>{p.stats_display[c.key] ?? 'N/A'}</td>
                  ))}
                  <td className={styles.num}>{fmtMoney(p.stats['Final Value (with)'])}</td>
                  <td className={styles.num}>{fmtMoney(p.stats['Total Money Added'])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
