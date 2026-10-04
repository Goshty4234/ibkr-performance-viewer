'use client';

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { DailyNavPoint } from '@/lib/types';
import type { DbHoldings } from '@/lib/holdings-db';
import {
  allocationAt, CASH_KEY, dayIndexAtOrBefore, donutSlices, evolution, OTHERS_KEY, positionsAt, tradeStats,
  type PositionRow,
} from '@/lib/holdings-analytics';
import styles from './AccountExtras.module.css';

interface Props {
  holdings: DbHoldings;
  navPoints: DailyNavPoint[];
  rangeStart: string;
  rangeEnd: string;
}

type Tab = 'repartition' | 'evolution' | 'positions' | 'transactions';

const PALETTE = [
  '#4d8dff', '#ffb020', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#38bdf8',
  '#e879f9', '#facc15', '#2dd4bf', '#f87171', '#818cf8', '#34d399', '#fb7185', '#60a5fa',
];
const COLOR_CASH = '#4ade80';
const COLOR_OTHERS = '#6b7a94';

/** The same holding keeps the same colour in every chart and on every date. */
function colorOf(key: string): string {
  if (key === CASH_KEY) return COLOR_CASH;
  if (key === OTHERS_KEY) return COLOR_OTHERS;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function money(v: number, cur: string, digits = 0): string {
  const sym = cur === 'CAD' || cur === 'USD' ? '$' : cur;
  return `${v.toLocaleString('fr-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${sym}`;
}
const pct = (v: number, d = 1) => `${v.toFixed(d)} %`;
const dayLabel = (d: string) => format(new Date(d + 'T12:00:00'), 'd MMM yyyy', { locale: fr });

function Stat({ label, value, sub, cls }: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={`${styles.statValue} ${cls ?? ''}`}>{value}</div>
      {sub && <div className={styles.statSub}>{sub}</div>}
    </div>
  );
}

export default function HoldingsPanel({ holdings, navPoints, rangeStart, rangeEnd }: Props) {
  const [tab, setTab] = useState<Tab>('repartition');
  const cur = holdings.baseCurrency;
  const lastIdx = useMemo(() => {
    const i = dayIndexAtOrBefore(holdings, rangeEnd);
    return i >= 0 ? i : holdings.days.length - 1;
  }, [holdings, rangeEnd]);
  const [dayIdx, setDayIdx] = useState(lastIdx);
  useEffect(() => setDayIdx(lastIdx), [lastIdx]);

  const items = useMemo(() => allocationAt(holdings, navPoints, dayIdx), [holdings, navPoints, dayIdx]);
  const slices = useMemo(() => donutSlices(items), [items]);
  const total = items.reduce((a, i) => a + i.value, 0);
  const evo = useMemo(() => evolution(holdings, navPoints, rangeStart, rangeEnd), [holdings, navPoints, rangeStart, rangeEnd]);
  const rows = useMemo(() => positionsAt(holdings, navPoints, dayIdx), [holdings, navPoints, dayIdx]);
  const stats = useMemo(() => tradeStats(holdings.trades, rangeStart, rangeEnd), [holdings.trades, rangeStart, rangeEnd]);

  const [sort, setSort] = useState<{ key: keyof PositionRow; dir: 1 | -1 }>({ key: 'value', dir: -1 });
  const sortedRows = useMemo(
    () => [...rows].sort((a, b) => {
      const x = a[sort.key];
      const y = b[sort.key];
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * sort.dir;
    }),
    [rows, sort],
  );
  const [query, setQuery] = useState('');
  const trades = useMemo(
    () => holdings.trades
      .filter((t) => t.date >= rangeStart && t.date <= rangeEnd && t.assetClass !== 'TAX')
      .filter((t) => !query || `${t.symbol} ${t.label}`.toLowerCase().includes(query.toLowerCase()))
      .reverse(),
    [holdings.trades, rangeStart, rangeEnd, query],
  );

  if (!holdings.days.length && !holdings.trades.length) return null;
  const day = holdings.days[dayIdx];
  const th = (key: keyof PositionRow, label: string) => (
    <th
      className={styles.sortable}
      onClick={() => setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }))}
    >
      {label}{sort.key === key ? (sort.dir === -1 ? ' ▼' : ' ▲') : ''}
    </th>
  );
  const tabs: [Tab, string][] = [
    ['repartition', 'Répartition'],
    ['evolution', 'Évolution des actifs'],
    ['positions', 'Positions'],
    ['transactions', 'Transactions et frais'],
  ];
  const dateSlider = day && (
    <div className={styles.dateRow}>
      <span className={styles.dateLabel}>{dayLabel(day.date)}</span>
      <input
        type="range"
        min={0}
        max={holdings.days.length - 1}
        value={dayIdx}
        onChange={(e) => setDayIdx(Number(e.target.value))}
        aria-label="Date des positions"
      />
    </div>
  );
  const shorts = items.filter((i) => i.value < 0 && i.key !== CASH_KEY);

  return (
    <div className={styles.card}>
      <div className={styles.title}>Positions et transactions</div>
      <div className={styles.sub}>
        Lu directement dans les sections Open Positions et Trades de ton fichier IBKR, converti en {cur} avec les taux de
        IBKR. Les positions concordent avec la valeur des actions et options du compte, jour par jour.
      </div>
      <div className={styles.tabs} role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k}
            className={`${styles.tab} ${tab === k ? styles.tabOn : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'repartition' && day && (
        <>
          {dateSlider}
          <div className={styles.split}>
            <div className={styles.donut}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={slices} dataKey="value" nameKey="symbol" innerRadius="58%" outerRadius="92%" paddingAngle={1} isAnimationActive={false} stroke="none">
                    {slices.map((s) => <Cell key={s.key} fill={colorOf(s.key)} />)}
                  </Pie>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const s = payload[0].payload as (typeof slices)[number];
                      return (
                        <div className={styles.tip}>
                          <div><b>{s.symbol}</b> · {s.label}</div>
                          <div>{money(s.value, cur)} · {pct(s.pct)}</div>
                        </div>
                      );
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div className={styles.donutCenter}>
                <b>{money(total, cur)}</b>
                <span>{rows.length} positions</span>
              </div>
            </div>
            <div className={styles.legendList}>
              {slices.map((s) => (
                <div key={s.key} className={styles.legendItem} title={s.label}>
                  <i className={styles.dot} style={{ background: colorOf(s.key) }} />
                  <span className="n">{s.symbol}</span>
                  <span className="p">{pct(s.pct)}</span>
                </div>
              ))}
            </div>
          </div>
          {(shorts.length > 0 || items.some((i) => i.key === CASH_KEY && i.value < 0)) && (
            <p className={styles.note}>
              Le camembert montre ce qui est détenu. Exclus : {shorts.map((s) => `${s.symbol} (${pct(s.pct)})`).join(', ')}
              {items.some((i) => i.key === CASH_KEY && i.value < 0) ? `${shorts.length ? ', ' : ''}cash négatif (marge)` : ''}.
            </p>
          )}
        </>
      )}

      {tab === 'evolution' && (
        evo.rows.length < 2 ? <p className={styles.note}>Pas assez de jours de positions dans la plage choisie.</p> : (
          <>
            <div className={styles.chart}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={evo.rows} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(v: string) => format(new Date(v + 'T12:00:00'), 'MMM yy', { locale: fr })}
                    stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={40} />
                  <YAxis tickFormatter={(v: number) => `${Math.round(v)}%`} stroke="#5c6d85" fontSize={11} tickLine={false} axisLine={false} width={48} />
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const list = [...payload].filter((p) => Number(p.value) > 0.05).sort((a, b) => Number(b.value) - Number(a.value));
                      return (
                        <div className={styles.tip}>
                          <div><b>{dayLabel(String(label))}</b></div>
                          {list.slice(0, 10).map((p) => (
                            <div key={String(p.dataKey)}><i className={styles.dot} style={{ background: String(p.color) }} />{p.name} : {pct(Number(p.value))}</div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  {evo.keys.map((k) => (
                    <Area key={k.key} type="monotone" dataKey={k.key} name={k.label} stackId="w"
                      stroke={colorOf(k.key)} fill={colorOf(k.key)} fillOpacity={0.55} isAnimationActive={false} />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className={styles.legend}>
              {evo.keys.map((k) => (
                <span key={k.key}><i className={styles.dot} style={{ background: colorOf(k.key) }} />{k.label}</span>
              ))}
            </div>
            <p className={styles.note}>
              Poids de chaque titre dans le compte, jour par jour. Un total au-dessus de 100 % veut dire que le compte
              utilisait de la marge. Les 12 plus gros titres sont affichés un par un, les autres sont regroupés.
            </p>
          </>
        )
      )}

      {tab === 'positions' && day && (
        <>
          {dateSlider}
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {th('symbol', 'Titre')}{th('label', 'Description')}{th('qty', 'Quantité')}{th('price', 'Prix')}
                  {th('value', 'Valeur')}{th('pct', '% du compte')}{th('cost', 'Coût')}{th('pnl', 'Gain latent')}{th('pnlPct', 'Gain %')}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
                  <tr key={r.key}>
                    <td><i className={styles.dot} style={{ background: colorOf(r.key) }} />{r.symbol}</td>
                    <td style={{ textAlign: 'left' }}>{r.label}</td>
                    <td className="mono">{r.qty.toLocaleString('fr-CA', { maximumFractionDigits: 4 })}</td>
                    <td className="mono">{r.price.toLocaleString('fr-CA', { maximumFractionDigits: 2 })}</td>
                    <td className="mono">{money(r.value, cur)}</td>
                    <td className="mono">{pct(r.pct)}</td>
                    <td className="mono">{money(r.cost, cur)}</td>
                    <td className={`mono ${r.pnl >= 0 ? 'positive' : 'negative'}`}>{money(r.pnl, cur)}</td>
                    <td className={`mono ${(r.pnlPct ?? 0) >= 0 ? 'positive' : 'negative'}`}>{r.pnlPct === null ? '—' : pct(r.pnlPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.note}>Prix dans la devise du titre ; valeur, coût et gain latent en {cur}.</p>
        </>
      )}

      {tab === 'transactions' && (
        <>
          <div className={styles.cards}>
            <Stat label="Transactions" value={String(stats.count)} sub={`${stats.buys} achats · ${stats.sells} ventes`} />
            <Stat label="Frais de transaction" value={money(stats.fees, cur, 2)}
              sub={`Commissions ${money(stats.commissions, cur, 2)} · taxes ${money(stats.taxes, cur, 2)}`} />
            <Stat label="Gain réalisé" value={money(stats.realized, cur)} cls={stats.realized >= 0 ? 'positive' : 'negative'} sub="Ventes de la période (FIFO)" />
            <Stat label="Volume échangé" value={money(stats.volume, cur)}
              sub={stats.volume > 0 ? `Frais : ${(stats.fees / stats.volume * 100).toFixed(3)} % du volume` : undefined} />
          </div>

          {stats.byMonth.length > 0 && (
            <>
              <div className={styles.h3}>Frais par mois</div>
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={stats.byMonth} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="month" tickFormatter={(v: string) => format(new Date(v + '-01T12:00:00'), 'MMM yy', { locale: fr })} stroke="#5c6d85" fontSize={11} tickLine={false} />
                    <YAxis tickFormatter={(v: number) => `${v} $`} stroke="#5c6d85" fontSize={11} tickLine={false} axisLine={false} width={48} />
                    <Tooltip content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const m = payload[0].payload as (typeof stats.byMonth)[number];
                      return <div className={styles.tip}><b>{m.month}</b><div>Frais : {money(m.fees, cur, 2)}</div><div>{m.trades} transactions</div></div>;
                    }} />
                    <Bar dataKey="fees" fill="#ffb020" isAnimationActive={false} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          <div className={styles.dateRow} style={{ marginTop: '1rem' }}>
            <div className={styles.h3} style={{ margin: 0 }}>Transactions ({trades.length})</div>
            <input className={styles.search} placeholder="Filtrer par titre…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead>
                <tr><th>Date</th><th>Titre</th><th>Sens</th><th>Quantité</th><th>Prix</th><th>Montant</th><th>Frais</th><th>Gain réalisé</th></tr>
              </thead>
              <tbody>
                {trades.map((t, i) => (
                  <tr key={`${t.date}${t.time}${t.symbol}${i}`}>
                    <td>{dayLabel(t.date)}</td>
                    <td style={{ textAlign: 'left' }} title={t.label}>{t.symbol}</td>
                    <td className={t.side === 'BUY' ? 'positive' : 'negative'}>{t.side === 'BUY' ? 'Achat' : 'Vente'}</td>
                    <td className="mono">{t.qty.toLocaleString('fr-CA', { maximumFractionDigits: 4 })}</td>
                    <td className="mono">{t.price.toLocaleString('fr-CA', { maximumFractionDigits: 4 })}</td>
                    <td className="mono">{money(Math.abs(t.proceeds), cur, 2)}</td>
                    <td className="mono">{money(-(t.commission + t.taxes), cur, 2)}</td>
                    <td className={`mono ${t.realized > 0 ? 'positive' : t.realized < 0 ? 'negative' : ''}`}>{t.realized ? money(t.realized, cur, 2) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stats.taxes === 0 && (
            <p className={styles.note}>Aucune taxe de transaction dans ton fichier : les frais sont les commissions IBKR de chaque exécution.</p>
          )}

          {stats.bySymbol.length > 0 && (
            <>
              <div className={styles.h3}>Gain réalisé par titre</div>
              <div className={styles.tableScroll} style={{ maxHeight: 300 }}>
                <table className={styles.table}>
                  <thead><tr><th>Titre</th><th>Transactions</th><th>Frais</th><th>Gain réalisé</th></tr></thead>
                  <tbody>
                    {stats.bySymbol.map((s) => (
                      <tr key={s.symbol}>
                        <td title={s.label}>{s.symbol}</td>
                        <td className="mono">{s.trades}</td>
                        <td className="mono">{money(s.fees, cur, 2)}</td>
                        <td className={`mono ${s.realized >= 0 ? 'positive' : 'negative'}`}>{money(s.realized, cur)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
