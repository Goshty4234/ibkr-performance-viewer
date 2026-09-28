'use client';

import { useEffect, useMemo, useState } from 'react';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { FREQUENCY_LABELS, formatTimeUntil, nextRebalance } from '@/lib/backtest/timer';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import { SERIES_PALETTE } from '@/lib/chart-series';
import type { AllocationTable, PieSlices, PortfolioSummaryOk } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import { money, pct, qty } from './format';
import styles from '../Results.module.css';

export function Pie({ slices, height = 300, labels = true }: { slices: PieSlices; height?: number; labels?: boolean }) {
  const option = useMemo(() => ({
    tooltip: { trigger: 'item', formatter: (p: { name: string; value: number }) => `${p.name} : <b>${p.value.toFixed(2)}%</b>` },
    series: [{
      type: 'pie',
      radius: labels ? ['38%', '70%'] : ['52%', '86%'],
      avoidLabelOverlap: true,
      itemStyle: { borderColor: '#0b1220', borderWidth: 2 },
      label: labels
        ? { color: '#c7d2e0', fontSize: 11, formatter: (p: { name: string; value: number }) => `${p.name}\n${p.value.toFixed(1)}%` }
        : { show: false },
      labelLine: { lineStyle: { color: 'rgba(255,255,255,0.25)' } },
      data: slices.map(([name, value], i) => ({
        name, value, itemStyle: { color: name === 'CASH' ? '#5c6d85' : SERIES_PALETTE[i % SERIES_PALETTE.length] },
      })),
    }],
  }), [slices, labels]);
  if (!slices.length) return <div className={styles.muted}>Aucune allocation.</div>;
  return <EChart option={option} height={height} />;
}

export function AllocTable({ table }: { table: AllocationTable | null }) {
  if (!table) return <div className={styles.muted}>Tableau indisponible.</div>;
  return (
    <div className={styles.tableScroll} style={{ maxHeight: 360 }}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={styles.stickyCol}>Ticker</th>
            <th>Allocation %</th>
            <th>Prix</th>
            <th>Actions</th>
            <th>Valeur</th>
            <th>% du portefeuille</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr key={r.ticker}>
              <td className={styles.stickyCol}><strong>{r.ticker}</strong></td>
              <td className={styles.num}>{pct(r.alloc_pct)}</td>
              <td className={styles.num}>{r.price === null ? 'N/A' : money(r.price)}</td>
              <td className={styles.num}>{r.ticker === 'CASH' ? '' : r.shares.toFixed(1)}</td>
              <td className={styles.num}>{money(r.value)}</td>
              <td className={styles.num}>{pct(r.pct)}</td>
            </tr>
          ))}
          <tr className={styles.totalRow}>
            <td className={styles.stickyCol}>TOTAL</td>
            <td className={styles.num}>{pct(table.total.alloc_pct)}</td>
            <td />
            <td />
            <td className={styles.num}>{money(table.total.value)}</td>
            <td className={styles.num}>{pct(table.total.pct)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Countdown({ frequency, last }: { frequency: string; last: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  const next = nextRebalance(frequency, last, now);
  return (
    <div className={styles.kpis}>
      <div><span>Fréquence</span><strong>{FREQUENCY_LABELS[frequency] ?? frequency}</strong></div>
      <div><span>Dernier rebalancement</span><strong>{last}</strong></div>
      <div>
        <span>Prochain rebalancement</span>
        <strong>{next ? next.date.toLocaleDateString('fr-CA') : 'Aucun'}</strong>
      </div>
      <div><span>Temps restant</span><strong>{next ? formatTimeUntil(next.msUntil) : '—'}</strong></div>
    </div>
  );
}

export function PurchaseCalculator({ weights, prices }: { weights: Record<string, number>; prices: Record<string, number | null> }) {
  const [amount, setAmount] = useState(10000);
  const rows = Object.entries(weights)
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([t, w]) => {
      const price = t === 'CASH' ? null : prices[t] ?? null;
      const value = amount * w;
      const shares = price && price > 0 ? Math.floor(value / price) : null;
      return { t, w, price, value, shares, spent: shares !== null && price ? shares * price : t === 'CASH' ? value : null };
    });
  const spent = rows.reduce((a, r) => a + (r.spent ?? 0), 0);
  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Calculateur d&apos;achat</div>
          <div className={styles.cardSub}>Répartit un montant selon les poids d&apos;aujourd&apos;hui au dernier prix connu (actions entières)</div>
        </div>
        <label className={styles.inlineField}>
          Montant
          <input type="number" className="input" style={{ width: 140 }} min={0} step={100} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} />
          $
        </label>
      </div>
      <div className={styles.padded}>
        <div className={styles.tableScroll} style={{ maxHeight: 360 }}>
          <table className={styles.table}>
            <thead>
              <tr><th className={styles.stickyCol}>Ticker</th><th>Poids</th><th>Prix</th><th>Montant cible</th><th>Actions à acheter</th><th>Coût réel</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.t}>
                  <td className={styles.stickyCol}><strong>{r.t}</strong></td>
                  <td className={styles.num}>{pct(r.w * 100)}</td>
                  <td className={styles.num}>{r.price === null ? 'N/A' : money(r.price)}</td>
                  <td className={styles.num}>{money(r.value)}</td>
                  <td className={styles.num}>{r.shares === null ? '' : qty(r.shares, 0)}</td>
                  <td className={styles.num}>{r.spent === null ? '' : money(r.spent)}</td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <td className={styles.stickyCol}>TOTAL</td><td /><td /><td className={styles.num}>{money(amount)}</td><td />
                <td className={styles.num}>{money(spent)} <span className={styles.muted}>(reste {money(amount - spent)})</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function TodayTab({
  result,
  portfolios,
  selected,
  onSelect,
}: {
  result: LoadedResult;
  portfolios: PortfolioSummaryOk[];
  selected: number | null;
  onSelect: (index: number) => void;
}) {
  const p = portfolios.find((x) => x.index === selected) ?? portfolios[0];
  const { detail } = usePortfolioDetail(result, p?.index ?? null);
  const today = p?.today ?? null;
  const pie = useMemo<PieSlices>(() => {
    if (today?.pie?.length) return today.pie;
    const w = p?.today_weights ?? {};
    return Object.entries(w).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v * 100]);
  }, [today, p]);
  if (!p) return null;
  const cmp = detail?.rebalance_compare ?? null;
  const fusionJson = p.fusion ? JSON.stringify(p.config, null, 2) : null;

  return (
    <>
      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>Rebalancer aujourd&apos;hui</div>
            <div className={styles.cardSub}>
              Poids tirés des dernières métriques de momentum (ou de la configuration) · valeur du portefeuille {money(today?.portfolio_value ?? null)}
            </div>
          </div>
          <select className={styles.select} value={p.index} onChange={(e) => onSelect(Number(e.target.value))}>
            {portfolios.map((x) => <option key={x.index} value={x.index}>{x.name}</option>)}
          </select>
        </div>
        {p.timer && <Countdown frequency={p.timer.frequency} last={p.timer.last_rebalance} />}
        <div className={styles.allocGrid}>
          <div><Pie slices={pie} /></div>
          <div><AllocTable table={today?.table ?? null} /></div>
        </div>
      </div>

      {today && Object.keys(today.weights).length > 0 && <PurchaseCalculator weights={today.weights} prices={today.prices} />}

      {cmp && (
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>Dernier rebalancement vs allocation actuelle</div>
              <div className={styles.cardSub}>
                Cible au {cmp.last_date} comparée à la dérive au {cmp.final_date}
              </div>
            </div>
          </div>
          <div className={styles.compareGrid}>
            <div>
              <div className={styles.subTitle}>Au dernier rebalancement ({cmp.last_date})</div>
              <Pie slices={cmp.last_pie} height={260} />
              <AllocTable table={cmp.last_table} />
            </div>
            <div>
              <div className={styles.subTitle}>Actuel ({cmp.final_date})</div>
              <Pie slices={cmp.current_pie} height={260} />
              <AllocTable table={cmp.current_table} />
            </div>
          </div>
        </div>
      )}

      {fusionJson && (
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>Configuration de la fusion</div>
              <div className={styles.cardSub}>JSON exportable du portfolio fusionné</div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigator.clipboard?.writeText(fusionJson)}>Copier</button>
          </div>
          <pre className={styles.codeBlock}>{fusionJson}</pre>
        </div>
      )}
    </>
  );
}
