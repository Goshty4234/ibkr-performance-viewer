'use client';

import { useMemo, useState } from 'react';
import { MONEY_COLUMNS, STAT_COLUMNS, fmtMoney } from '@/lib/backtest/chart-data';
import type { PortfolioSummaryOk as PortfolioResultOk } from '@/lib/engine/types';
import styles from './Results.module.css';

type SortKey = string;

const LOWER_IS_BETTER = new Set(['Volatility', 'UlcerIndex', 'Beta', 'Total Money Added']);
const MONEY_KEYS = new Set(MONEY_COLUMNS.map((c) => c.key));

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
      const v = p.stats[sort.key];
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
  const columns = [...STAT_COLUMNS, ...MONEY_COLUMNS];

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
              {columns.map((c) => (
                <th key={c.key} title={c.title} onClick={() => clickSort(c.key)}>
                  {c.label}{arrow(c.key)}
                </th>
              ))}
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
                  {columns.map((c) => (
                    <td key={c.key} className={styles.num}>
                      {MONEY_KEYS.has(c.key) ? fmtMoney(p.stats[c.key]) : p.stats_display[c.key] ?? 'N/A'}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ColumnDefinitions columns={columns} />
    </div>
  );
}

export function ColumnDefinitions({ columns }: { columns: { label: string; title: string }[] }) {
  return (
    <details className={styles.colDefs}>
      <summary>ℹ️ Définitions des colonnes</summary>
      <dl>
        {columns.map((c) => (
          <div key={c.label}>
            <dt>{c.label}</dt>
            <dd>{c.title}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
