'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ExitedHolding } from '@/lib/backtest/allocation-exits';
import { planPurchases } from '@/lib/backtest/purchase-plan';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { FREQUENCY_LABELS, formatTimeUntil, nextRebalance } from '@/lib/backtest/timer';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import { SERIES_PALETTE } from '@/lib/chart-series';
import type { AllocationTable, PieSlices, PortfolioSummaryOk } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import { SortableTh, type SortValue, useTableSort } from '../SortableTh';
import { money, pct, qty } from './format';
import styles from '../Results.module.css';

export function Pie({
  slices,
  height = 300,
  labels = true,
  colors,
}: {
  slices: PieSlices;
  height?: number;
  labels?: boolean;
  /** Same color for the same ticker across two pies. */
  colors?: ReadonlyMap<string, string>;
}) {
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
        name,
        value,
        itemStyle: {
          color: colors?.get(name) ?? (name === 'CASH' ? '#5c6d85' : SERIES_PALETTE[i % SERIES_PALETTE.length]),
        },
      })),
    }],
  }), [slices, labels, colors]);
  if (!slices.length) return <div className={styles.muted}>Aucune allocation.</div>;
  return <EChart option={option} height={height} />;
}

type AllocRow = AllocationTable['rows'][number];
type ViewRow = AllocRow & { exit?: boolean; prevPct?: number; name?: string; kind?: 'new' | 'kept' | 'exit' };
const NO_ROWS: ViewRow[] = [];
const ALLOC_SORT: Record<string, (r: ViewRow) => SortValue> = {
  ticker: (r) => r.ticker,
  name: (r) => r.name || null,
  alloc: (r) => r.alloc_pct,
  price: (r) => r.price,
  shares: (r) => (r.ticker === 'CASH' || r.exit ? null : r.shares),
  value: (r) => (r.exit ? null : r.value),
  pct: (r) => r.pct,
};

const EXITS_KEY = 'alloc-show-exits';

function useStoredFlag(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === '0' || stored === '1') setValue(stored === '1');
    } catch { /* private mode */ }
  }, [key]);
  const update = (v: boolean) => {
    setValue(v);
    try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* private mode */ }
  };
  return [value, update];
}

export type AllocExit = ExitedHolding;

export interface BookDateControl {
  /** Date the user picked. Empty until the programmed date is known. */
  value: string;
  /** Trading session the book was read from. */
  snapped: string | null;
  min?: string;
  max?: string;
  programmed: string;
  onChange: (day: string) => void;
}

function BookDateField({ book }: { book: BookDateControl }) {
  return (
    <>
      <div className={styles.bookDate}>
        <label className={styles.inlineField} title="Composition détenue par le backtest à cette date. Si le 1er tombe un week-end, la séance utilisée est le jour d’ouverture suivant, celui où le site rebalance.">
          Mon dernier rebalancement
          <input
            type="date"
            className="input"
            value={book.value}
            min={book.min || undefined}
            max={book.max || undefined}
            onChange={(e) => book.onChange(e.target.value)}
          />
        </label>
        {book.programmed && book.value !== book.programmed && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => book.onChange(book.programmed)}>
            Date programmée
          </button>
        )}
        {book.snapped && book.snapped !== book.value && (
          <span className={styles.exitEmpty}>Séance utilisée : {book.snapped}</span>
        )}
      </div>
      <p className={styles.bookDateNote}>
        Les poids du tableau restent la cible d’aujourd’hui. Cette date ne change que les couleurs, et seulement quand elle franchit un rebalancement.
      </p>
    </>
  );
}

function StableText({ text, width, muted }: { text: string; width: string; muted?: boolean }) {
  return (
    <span className={styles.stableNum}>
      <span className={styles.stableSizer} aria-hidden>{width}</span>
      <span className={muted ? styles.muted : undefined}>{text}</span>
    </span>
  );
}

function BookLegend({ kept, added, sold }: { kept: number; added: number; sold: number }) {
  return (
    <div className={styles.bookLegend} aria-hidden>
      <span className={styles.tagNew}>Nouveau {added}</span>
      <span>Conservé {kept}</span>
      <span className={styles.tagExit}>À vendre {sold}</span>
    </div>
  );
}

function rowKind(ticker: string, exit: boolean, held: ReadonlySet<string> | null): 'new' | 'kept' | 'exit' {
  if (exit) return 'exit';
  if (!held || ticker === 'CASH') return 'kept';
  return held.has(ticker) ? 'kept' : 'new';
}

export function AllocTable({
  table,
  names,
  exits,
  exitsPending,
  rebalance,
  held,
  book,
  showExits: showExitsProp,
  onShowExits,
}: {
  table: AllocationTable | null;
  /** Company names already loaded with the fundamentals. Absent = no Société column. */
  names?: Record<string, string>;
  exits?: AllocExit[];
  exitsPending?: boolean;
  /** Fullscreen, company names, and the reference-book comparison. */
  rebalance?: boolean;
  /** Tickers held on the reference date. Null while that book is still loading. */
  held?: ReadonlySet<string> | null;
  book?: BookDateControl;
  showExits?: boolean;
  onShowExits?: (v: boolean) => void;
}) {
  const [storedExits, setStoredExits] = useStoredFlag(EXITS_KEY, true);
  const showExits = showExitsProp ?? storedExits;
  const setShowExits = onShowExits ?? setStoredExits;
  const [fullscreen, setFullscreen] = useState(false);
  const showNames = names !== undefined;
  const known = held ?? null;
  const rows = useMemo(() => {
    const live: ViewRow[] = (table?.rows ?? []).map((r) => ({
      ...r,
      name: names?.[r.ticker],
      kind: rowKind(r.ticker, false, known),
    }));
    if (!rebalance || !showExits) return live;
    const gone: ViewRow[] = (exits ?? []).map((e) => ({
      ticker: e.ticker,
      alloc_pct: 0,
      price: null,
      shares: 0,
      value: 0,
      pct: 0,
      exit: true,
      prevPct: e.prevPct,
      name: names?.[e.ticker],
      kind: 'exit' as const,
    }));
    return [...live, ...gone];
  }, [table, names, exits, rebalance, showExits, known]);
  const { sorted, sort, toggle } = useTableSort(rows.length ? rows : NO_ROWS, ALLOC_SORT);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  if (!table) return <div className={styles.muted}>Tableau indisponible.</div>;
  const th = { sort, onSort: toggle };
  const exitCount = exits?.length ?? 0;
  const added = known ? (table.rows.filter((r) => r.ticker !== 'CASH' && !known.has(r.ticker)).length) : 0;
  const kept = known ? (table.rows.filter((r) => r.ticker !== 'CASH' && known.has(r.ticker)).length) : 0;
  const kindClass = (kind?: ViewRow['kind']) => (kind === 'exit' ? styles.rowExit : kind === 'new' ? styles.rowNew : undefined);
  return (
    <div className={fullscreen ? styles.tableFullscreen : styles.tableStage}>
      {rebalance && (
        <>
          <div className={styles.tableTools}>
            <label className={styles.inlineField} title="Titres détenus à la date de référence et absents de la cible. En rouge : à vendre.">
              <input type="checkbox" checked={showExits} onChange={(e) => setShowExits(e.target.checked)} />
              Titres à retirer
              {showExits && !exitsPending && exitCount > 0 ? ` (${exitCount})` : ''}
            </label>
            {known && <BookLegend kept={kept} added={added} sold={showExits ? exitCount : 0} />}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFullscreen((v) => !v)}>
              {fullscreen ? 'Quitter le plein écran' : 'Plein écran'}
            </button>
          </div>
          {book && <BookDateField book={book} />}
        </>
      )}
      {rebalance && showExits && !exitsPending && exitCount === 0 && (
        <div className={styles.exitEmpty}>Aucun titre à retirer par rapport à cette date.</div>
      )}
      <div className={styles.tableScroll} style={fullscreen ? undefined : { maxHeight: 360 }}>
        <table className={styles.table}>
          <thead>
            <tr>
              <SortableTh k="ticker" text className={styles.stickyCol} {...th}>Ticker</SortableTh>
              {showNames && (
                <SortableTh k="name" text className={styles.companyCol} {...th} title="Nom déjà chargé avec les fondamentaux (cache Yahoo 24 h, pas d’appel en plus). Cliquer pour trier.">
                  Société
                </SortableTh>
              )}
              <SortableTh k="alloc" {...th}>Allocation %</SortableTh>
              <SortableTh k="price" {...th}>Prix</SortableTh>
              <SortableTh k="shares" {...th}>Actions</SortableTh>
              <SortableTh k="value" {...th}>Valeur</SortableTh>
              <SortableTh k="pct" {...th}>% du portefeuille</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.exit ? `exit-${r.ticker}` : r.ticker} className={kindClass(r.kind)}>
                <td className={styles.stickyCol}>
                  <strong>{r.ticker}</strong>
                  {r.kind === 'new' && <span className={styles.tag}>Nouveau</span>}
                  {r.kind === 'exit' && <span className={styles.tag}>À vendre</span>}
                </td>
                {showNames && (
                  <td className={styles.companyCol} title={r.name || undefined}>{r.name || '—'}</td>
                )}
                <td className={r.exit ? `${styles.num} ${styles.exitAlloc}` : styles.num}>
                  {pct(r.alloc_pct)}
                  {r.exit && r.prevPct != null && <span className={styles.exitWas}>était {pct(r.prevPct)}</span>}
                </td>
                <td className={styles.num}>{r.exit ? '—' : r.price === null ? 'N/A' : money(r.price)}</td>
                <td className={styles.num}>{r.ticker === 'CASH' || r.exit ? '' : r.shares.toFixed(1)}</td>
                <td className={styles.num}>{r.exit ? '—' : money(r.value)}</td>
                <td className={styles.num}>{pct(r.pct)}</td>
              </tr>
            ))}
            <tr className={styles.totalRow}>
              <td className={styles.stickyCol}>TOTAL</td>
              {showNames && <td />}
              <td className={styles.num}>{pct(table.total.alloc_pct)}</td>
              <td />
              <td />
              <td className={styles.num}>{money(table.total.value)}</td>
              <td className={styles.num}>{pct(table.total.pct)}</td>
            </tr>
          </tbody>
        </table>
      </div>
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

interface BuyRow {
  t: string;
  w: number;
  price: number | null;
  value: number;
  shares: number | null;
  spent: number | null;
  name?: string;
  kind: 'new' | 'kept' | 'exit';
  prevPct?: number;
}
const BUY_SORT: Record<string, (r: BuyRow) => SortValue> = {
  ticker: (r) => r.t,
  name: (r) => r.name || null,
  w: (r) => r.w,
  price: (r) => r.price,
  value: (r) => r.value,
  shares: (r) => r.shares,
  spent: (r) => r.spent,
};
const FILL_KEY = 'alloc-fill-cash';

function tickerColors(target: PieSlices, actual: PieSlices): Map<string, string> {
  const order = [...target].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  for (const [name] of [...actual].sort((a, b) => b[1] - a[1])) {
    if (!order.includes(name)) order.push(name);
  }
  const colors = new Map<string, string>();
  let i = 0;
  for (const name of order) {
    if (name === 'CASH') {
      colors.set(name, '#5c6d85');
      continue;
    }
    colors.set(name, SERIES_PALETTE[i % SERIES_PALETTE.length]);
    i += 1;
  }
  return colors;
}

/** Target weights versus the whole-share order, as percents of the typed amount. */
function purchaseShape(rows: readonly BuyRow[], amount: number, spent: number): { target: PieSlices; actual: PieSlices } {
  const live = rows.filter((r) => r.kind !== 'exit');
  const target: PieSlices = live
    .filter((r) => r.w > 0)
    .map((r) => [r.t, r.w * 100] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  const dollars = new Map<string, number>();
  for (const r of live) {
    if (r.spent == null || r.spent <= 0) continue;
    dollars.set(r.t, (dollars.get(r.t) ?? 0) + r.spent);
  }
  const left = Math.max(0, amount - spent);
  if (left > 0.005) dollars.set('CASH', (dollars.get('CASH') ?? 0) + left);
  const actual: PieSlices = [...dollars.entries()]
    .filter(([, value]) => amount > 0 && value > 0)
    .map(([name, value]) => [name, (value / amount) * 100] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  return { target, actual };
}

export function PurchaseCalculator({
  weights,
  prices,
  names,
  exits,
  held,
  book,
  portfolioValue,
  capFor,
  showExits: showExitsProp,
  onShowExits,
}: {
  weights: Record<string, number>;
  prices: Record<string, number | null>;
  names?: Record<string, string>;
  exits?: AllocExit[];
  held?: ReadonlySet<string> | null;
  book?: BookDateControl;
  /** Value typed at the top of the Allocations page. */
  portfolioValue?: number | null;
  /** Max fraction of the amount for one ticker, or null when that name has no cap. */
  capFor?: (ticker: string) => number | null;
  showExits?: boolean;
  onShowExits?: (v: boolean) => void;
}) {
  const [amount, setAmount] = useState(10000);
  const [fill, setFill] = useStoredFlag(FILL_KEY, false);
  const [storedExits, setStoredExits] = useStoredFlag(EXITS_KEY, true);
  const showExits = showExitsProp ?? storedExits;
  const setShowExits = onShowExits ?? setStoredExits;
  const [fullscreen, setFullscreen] = useState(false);
  const compare = held !== undefined;
  const rows = useMemo(() => {
    const planned = planPurchases(
      amount,
      Object.entries(weights).filter(([, w]) => w > 0).map(([t, w]) => ({ ticker: t, weight: w, price: t === 'CASH' ? null : prices[t] ?? null })),
      fill,
      capFor ?? (() => null),
    );
    const live: BuyRow[] = planned.map((line) => ({
      t: line.ticker,
      w: line.weight,
      price: line.price,
      value: line.targetValue,
      shares: line.price ? line.shares : null,
      spent: line.spent,
      name: names?.[line.ticker],
      kind: rowKind(line.ticker, false, held ?? null),
    }));
    const cashW = weights.CASH ?? 0;
    if (cashW > 0) {
      live.push({ t: 'CASH', w: cashW, price: null, value: amount * cashW, shares: null, spent: amount * cashW, kind: 'kept' });
    }
    if (!compare || !showExits) return live;
    const gone: BuyRow[] = (exits ?? []).map((e) => ({
      t: e.ticker,
      w: 0,
      price: null,
      value: 0,
      shares: null,
      spent: null,
      name: names?.[e.ticker],
      kind: 'exit' as const,
      prevPct: e.prevPct,
    }));
    return [...live, ...gone];
  }, [weights, prices, amount, fill, capFor, names, held, compare, showExits, exits]);
  const spent = rows.reduce((a, r) => a + (r.kind === 'exit' ? 0 : (r.spent ?? 0)), 0);
  const shape = useMemo(() => purchaseShape(rows, amount, spent), [rows, amount, spent]);
  const shapeColors = useMemo(() => tickerColors(shape.target, shape.actual), [shape]);
  const { sorted, sort, toggle } = useTableSort(rows, BUY_SORT);
  const th = { sort, onSort: toggle };
  const showNames = names !== undefined;
  const known = held ?? null;
  const added = known ? rows.filter((r) => r.kind === 'new').length : 0;
  const kept = known ? rows.filter((r) => r.kind === 'kept' && r.t !== 'CASH').length : 0;
  const sold = showExits ? (exits?.length ?? 0) : 0;

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [fullscreen]);

  const kindClass = (kind: BuyRow['kind']) => (kind === 'exit' ? styles.rowExit : kind === 'new' ? styles.rowNew : undefined);
  return (
    <div className={fullscreen ? styles.tableFullscreen : 'card'}>
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Calculateur d&apos;achat</div>
          <div className={styles.cardSub}>
            Actions entières, arrondies vers le bas pour ne pas dépasser le montant.
            {' '}« Remplir le cash » rachète le surplus une action à la fois, sur le titre le plus en dessous de son poids, sans passer son plafond.
          </div>
        </div>
        <div className={styles.tableTools}>
          <label className={styles.inlineField}>
            Montant
            <input type="number" className="input" style={{ width: 140 }} min={0} step={100} value={amount} onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))} />
            $
          </label>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={portfolioValue == null}
            title={portfolioValue == null ? 'Entre d’abord la valeur du portefeuille en haut de la page' : 'Reprend le montant saisi dans « Valeur de mon portefeuille »'}
            onClick={() => portfolioValue != null && setAmount(portfolioValue)}
          >
            Reprendre ma valeur
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFullscreen((v) => !v)}>
            {fullscreen ? 'Quitter le plein écran' : 'Plein écran'}
          </button>
        </div>
      </div>
      <div className={styles.padded}>
        <div className={styles.tableTools}>
          <label className={styles.inlineField} title="Après l’arrondi vers le bas, dépense le cash restant (hors poche cash prévue) sans dépasser le plafond de chaque titre.">
            <input type="checkbox" checked={fill} onChange={(e) => setFill(e.target.checked)} />
            Remplir le cash
          </label>
          {compare && (
            <label className={styles.inlineField}>
              <input type="checkbox" checked={showExits} onChange={(e) => setShowExits(e.target.checked)} />
              Titres à vendre
            </label>
          )}
          {known && <BookLegend kept={kept} added={added} sold={sold} />}
        </div>
        {book && <BookDateField book={book} />}
        <div className={styles.tableScroll} style={fullscreen ? undefined : { maxHeight: 360 }}>
          <table className={styles.table}>
            <thead>
              <tr>
                <SortableTh k="ticker" text className={styles.stickyCol} {...th}>Ticker</SortableTh>
                {showNames && <SortableTh k="name" text className={styles.companyCol} {...th}>Société</SortableTh>}
                <SortableTh k="w" {...th}>Poids</SortableTh>
                <SortableTh k="price" {...th}>Prix</SortableTh>
                <SortableTh k="value" {...th}>Montant cible</SortableTh>
                <SortableTh k="shares" {...th}>Actions</SortableTh>
                <SortableTh k="spent" {...th}>Coût réel</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.kind === 'exit' ? `exit-${r.t}` : r.t} className={kindClass(r.kind)}>
                  <td className={styles.stickyCol}>
                    <strong>{r.t}</strong>
                    {r.kind === 'new' && <span className={styles.tag}>Nouveau</span>}
                    {r.kind === 'exit' && <span className={styles.tag}>À vendre</span>}
                  </td>
                  {showNames && <td className={styles.companyCol} title={r.name || undefined}>{r.name || '—'}</td>}
                  <td className={styles.num}>
                    {pct(r.w * 100)}
                    {r.kind === 'exit' && r.prevPct != null && <span className={styles.exitWas}>était {pct(r.prevPct)}</span>}
                  </td>
                  <td className={styles.num}>{r.kind === 'exit' ? '—' : r.price === null ? 'N/A' : money(r.price)}</td>
                  <td className={styles.num}>{r.kind === 'exit' ? '—' : money(r.value)}</td>
                  <td className={styles.num}>{r.kind === 'exit' ? 'Tout vendre' : r.shares === null ? '' : qty(r.shares, 0)}</td>
                  <td className={styles.num}>{r.spent === null ? '' : money(r.spent)}</td>
                </tr>
              ))}
              <tr className={styles.totalRow}>
                <td className={styles.stickyCol}>TOTAL</td>
                {showNames && <td />}
                <td /><td /><td className={styles.num}>{money(amount)}</td><td />
                <td className={styles.num}>
                  <StableText text={money(spent)} width={money(amount)} />
                  {' '}
                  <StableText text={`(reste ${money(Math.max(0, amount - spent))})`} width={`(reste ${money(amount)})`} muted />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {amount > 0 && shape.target.length > 0 && (
          <div className={styles.comparePies}>
            <div className={styles.comparePie}>
              <h3>Cible calculée</h3>
              <p>Poids demandés, avant l’arrondi en actions entières.</p>
              <Pie slices={shape.target} colors={shapeColors} height={320} />
            </div>
            <div className={styles.comparePie}>
              <h3>Portefeuille acheté</h3>
              <p>Coût réel des actions, plus le cash qui reste. Même couleur, même titre.</p>
              <Pie slices={shape.actual} colors={shapeColors} height={320} />
            </div>
          </div>
        )}
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
