'use client';

import { useEffect, useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import { SERIES_PALETTE } from '@/lib/chart-series';
import type { PortfolioDetail, PortfolioSummaryOk } from '@/lib/engine/types';
import PeriodFields from './results/PeriodFields';
import styles from './Results.module.css';

const MAX_AREA_TICKERS = 12;
const OTHERS = 'Autres';

/** Engine weights are fractions (0..1); tolerate percentage inputs. */
function asPct(weights: Record<string, number>): Record<string, number> {
  const vals = Object.values(weights).filter((v) => Number.isFinite(v));
  const sum = vals.reduce((a, b) => a + b, 0);
  const factor = sum > 1.5 ? 1 : 100;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, (Number.isFinite(v) ? v : 0) * factor]));
}

interface Evolution {
  rows: Record<string, number | string>[];
  keys: string[];
  dates: string[];
  weights: Record<string, (number | null)[]>;
  factor: number;
}

const EMPTY_EVOLUTION: Evolution = { rows: [], keys: [], dates: [], weights: {}, factor: 100 };
const TOOLTIP_LINES = 15;
const GREY = '#5c6d85';

/** Every non-zero position at original date index `i`, largest first (includes those grouped in "Autres"). */
function compositionAt(ev: Evolution, i: number): [string, number][] {
  const out: [string, number][] = [];
  for (const [t, series] of Object.entries(ev.weights)) {
    const v = (series[i] ?? 0) * ev.factor;
    if (v > 0.005) out.push([t, v]);
  }
  return out.sort((a, b) => b[1] - a[1]);
}

function indexOnOrBefore(dates: string[], day: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= day) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

/** Top names inside [start, end], so a short window is not painted with names that left years ago. */
function sliceEvolution(ev: Evolution, start: string, end: string): Evolution {
  if (!ev.dates.length) return ev;
  const i0 = ev.dates.findIndex((d) => d >= start);
  const i1 = indexOnOrBefore(ev.dates, end);
  if (i0 < 0 || i1 < i0) return { ...EMPTY_EVOLUTION, factor: ev.factor };
  const avg = Object.keys(ev.weights).map((t) => {
    let s = 0;
    const series = ev.weights[t];
    for (let i = i0; i <= i1; i++) s += series[i] ?? 0;
    return { t, s };
  }).sort((a, b) => b.s - a.s);
  const top = avg.slice(0, MAX_AREA_TICKERS).filter((x) => x.s > 0).map((x) => x.t);
  const rest = avg.slice(MAX_AREA_TICKERS).map((x) => x.t);
  const keys = rest.length ? [...top, OTHERS] : top;
  const rows: Record<string, number | string>[] = [];
  for (let i = i0; i <= i1; i++) {
    const row: Record<string, number | string> = { date: ev.dates[i], _i: i };
    for (const t of top) row[t] = (ev.weights[t][i] ?? 0) * ev.factor;
    if (rest.length) {
      let o = 0;
      for (const t of rest) o += ev.weights[t][i] ?? 0;
      row[OTHERS] = o * ev.factor;
    }
    rows.push(row);
  }
  return { rows, keys, dates: ev.dates.slice(i0, i1 + 1), weights: ev.weights, factor: ev.factor };
}

function buildEvolution(d: PortfolioDetail): Evolution {
  const { dates, weights } = d.allocations ?? { dates: [], weights: {} };
  const tickers = Object.keys(weights);
  if (!dates.length || !tickers.length) return EMPTY_EVOLUTION;

  let sample = 0;
  for (const t of tickers) for (const v of weights[t]) if (v !== null && Number.isFinite(v)) sample = Math.max(sample, v);
  const factor = sample > 1.5 ? 1 : 100;

  const avg = tickers.map((t) => {
    let s = 0;
    for (const v of weights[t]) if (v !== null && Number.isFinite(v)) s += v;
    return { t, s };
  }).sort((a, b) => b.s - a.s);
  const top = avg.slice(0, MAX_AREA_TICKERS).filter((x) => x.s > 0).map((x) => x.t);
  const rest = avg.slice(MAX_AREA_TICKERS).map((x) => x.t);
  const keys = rest.length ? [...top, OTHERS] : top;

  const rows: Record<string, number | string>[] = [];
  for (let i = 0; i < dates.length; i++) {
    const row: Record<string, number | string> = { date: dates[i], _i: i };
    for (const t of top) row[t] = (weights[t][i] ?? 0) * factor;
    if (rest.length) {
      let o = 0;
      for (const t of rest) o += weights[t][i] ?? 0;
      row[OTHERS] = o * factor;
    }
    rows.push(row);
  }
  return { rows, keys, dates, weights, factor };
}

function EvolutionTooltip({ active, payload, ev, colors }: {
  active?: boolean;
  payload?: { payload?: Record<string, number | string> }[];
  ev: Evolution;
  colors: Map<string, string>;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  const list = compositionAt(ev, Number(row._i));
  const shown = list.slice(0, TOOLTIP_LINES);
  const rest = list.slice(TOOLTIP_LINES);
  const restPct = rest.reduce((a, [, v]) => a + v, 0);
  return (
    <div className={styles.evoTip}>
      <div className={styles.evoTipHead}>{String(row.date)} · {list.length} position{list.length > 1 ? 's' : ''}</div>
      {shown.map(([t, v]) => (
        <div key={t} className={styles.evoTipRow}>
          <i style={{ background: colors.get(t) ?? GREY }} />
          <span>{t}</span>
          <strong>{v.toFixed(2)}%</strong>
        </div>
      ))}
      {rest.length > 0 && <div className={styles.evoTipMore}>+{rest.length} autres · {restPct.toFixed(2)}% — clique pour la liste complète</div>}
    </div>
  );
}

function WeightColumn({
  title,
  hint,
  rows,
  colors,
}: {
  title: string;
  hint: string;
  rows: [string, number][];
  colors: Map<string, string>;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? rows : rows.slice(0, 25);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return (
    <div>
      <div className={styles.subTitle}>{title}</div>
      <div className={styles.muted} style={{ fontSize: '0.75rem', margin: '0.15rem 0 0.5rem' }}>{hint}</div>
      {rows.length === 0 ? (
        <div className={styles.muted}>Aucune allocation à cette date.</div>
      ) : (
        <>
          <div className={styles.weightList}>
            {visible.map(([t, v], i) => (
              <div key={t} className={styles.weightRow}>
                <span className={styles.weightTicker}>{t}</span>
                <span className={styles.weightBarTrack}>
                  <span
                    className={styles.weightBar}
                    style={{
                      width: `${Math.min(100, Math.max(0, v))}%`,
                      background: t === 'CASH' ? GREY : (colors.get(t) ?? SERIES_PALETTE[i % SERIES_PALETTE.length]),
                    }}
                  />
                </span>
                <span className={styles.num}>{v.toFixed(2)}%</span>
              </div>
            ))}
          </div>
          <div className={styles.weightFoot}>
            <span>{rows.length} positions · total {total.toFixed(2)}%</span>
            {rows.length > 25 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAll((s) => !s)}>
                {showAll ? 'Réduire' : `Tout afficher (${rows.length})`}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default function AllocationPanel({
  result,
  portfolios,
  selected,
  onSelect,
  start,
  end,
  onRange,
}: {
  result: LoadedResult;
  portfolios: PortfolioSummaryOk[];
  selected: number | null;
  onSelect: (index: number) => void;
  start: string;
  end: string;
  onRange: (start: string, end: string) => void;
}) {
  const p = portfolios.find((x) => x.index === selected) ?? portfolios[0];
  const { detail, loading, error } = usePortfolioDetail(result, p?.index ?? null);

  const evolution = useMemo(() => (detail ? buildEvolution(detail) : EMPTY_EVOLUTION), [detail]);
  const view = useMemo(
    () => (start && end ? sliceEvolution(evolution, start, end) : evolution),
    [evolution, start, end],
  );
  const colors = useMemo(
    () => new Map(view.keys.map((k, i) => [k, k === OTHERS ? GREY : SERIES_PALETTE[i % SERIES_PALETTE.length]])),
    [view],
  );
  const held = useMemo(() => {
    const day = end || evolution.dates[evolution.dates.length - 1] || '';
    const i = indexOnOrBefore(evolution.dates, day);
    if (i < 0) return { date: '', rows: [] as [string, number][] };
    return { date: evolution.dates[i], rows: compositionAt(evolution, i) };
  }, [evolution, end]);
  const target = useMemo(() => {
    const day = end || evolution.dates[evolution.dates.length - 1] || '';
    const last = evolution.dates[evolution.dates.length - 1] ?? '';
    const atEnd = !day || !last || day >= last;
    if (atEnd && p && Object.keys(p.today_weights ?? {}).length) {
      const rows = Object.entries(asPct(p.today_weights))
        .filter(([, v]) => v > 0.005)
        .sort((a, b) => b[1] - a[1]);
      return {
        date: p.last_rebalance_date ?? last,
        rows,
        hint: 'Poids visés si le portefeuille était rebalancé maintenant.',
      };
    }
    const reb = (detail?.metrics?.dates ?? []).filter((d) => d <= day).at(-1);
    const i = reb ? indexOnOrBefore(evolution.dates, reb) : indexOnOrBefore(evolution.dates, day);
    if (i < 0) return { date: '', rows: [] as [string, number][], hint: 'Pas de cible enregistrée à cette date.' };
    return {
      date: evolution.dates[i],
      rows: compositionAt(evolution, i),
      hint: reb
        ? `Poids appliqués au rebalancement du ${evolution.dates[i]}.`
        : 'Pas de date de rebalancement séparée : mêmes poids que la détention.',
    };
  }, [evolution, end, p, detail]);
  const [pinned, setPinned] = useState<number | null>(null);
  const pinnedList = useMemo(() => (pinned === null ? [] : compositionAt(evolution, pinned)), [evolution, pinned]);
  const pinnedValid = pinned !== null && pinned < evolution.dates.length;
  useEffect(() => setPinned(null), [evolution, start, end]);

  if (!p) return null;
  const bounds = {
    min: result.summary.dates[0] ?? evolution.dates[0] ?? start,
    max: result.summary.dates[result.summary.dates.length - 1] ?? evolution.dates[evolution.dates.length - 1] ?? end,
  };

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Allocations</div>
          <div className={styles.cardSub}>
            Dernier rebalancement : {p.last_rebalance_date ?? 'N/A'}
            {detail?.metrics?.truncated && ' · historique des métriques tronqué'}
            {' · la période filtre aussi les tableaux plus bas'}
          </div>
        </div>
        <select className={styles.select} value={p.index} onChange={(e) => onSelect(Number(e.target.value))}>
          {portfolios.map((x) => <option key={x.index} value={x.index}>{x.name}</option>)}
        </select>
      </div>
      <div className={styles.toolbarRow}>
        <PeriodFields start={start} end={end} min={bounds.min} max={bounds.max} onChange={onRange} />
      </div>

      <div className={styles.allocLists}>
        <WeightColumn title="Cible" hint={target.hint} rows={target.rows} colors={colors} />
        <WeightColumn
          title="Actuelle"
          hint={held.date ? `Poids réellement détenus le ${held.date}, après la dérive des cours.` : 'Pas de détention à cette date.'}
          rows={held.rows}
          colors={colors}
        />
      </div>

      <div className={styles.allocEvolution}>
        <div className={styles.subTitle}>
          Évolution des allocations
          <span className={styles.muted} style={{ fontWeight: 400, marginLeft: 8 }}>
            poids détenus · survol : composition du jour · clic : liste complète
          </span>
        </div>
        {loading ? (
          <div className={styles.muted}>Chargement du détail…</div>
        ) : error ? (
          <div className={styles.muted}>{error}</div>
        ) : view.rows.length < 2 ? (
          <div className={styles.muted}>Pas d&apos;historique d&apos;allocation sur cette période.</div>
        ) : (
          <>
            <div style={{ height: 360, cursor: 'pointer' }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={view.rows}
                  margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                  onClick={(state) => {
                    const row = (state as { activePayload?: { payload?: Record<string, number | string> }[] } | null)?.activePayload?.[0]?.payload;
                    if (row) setPinned(Number(row._i));
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date" stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={48} tickFormatter={(d: string) => d.slice(0, 7)} />
                  <YAxis domain={[0, 100]} allowDataOverflow tickFormatter={(v) => `${v}%`} stroke="#5c6d85" fontSize={11} tickLine={false} axisLine={false} width={44} />
                  <Tooltip content={<EvolutionTooltip ev={evolution} colors={colors} />} />
                  {view.keys.map((k) => (
                    <Area
                      key={k}
                      type="stepAfter"
                      dataKey={k}
                      stackId="1"
                      stroke={colors.get(k)}
                      fill={colors.get(k)}
                      fillOpacity={0.55}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
            {pinnedValid && (
              <div className={styles.evoPinned}>
                <div className={styles.evoPinnedHead}>
                  <span>
                    Composition au <strong>{evolution.dates[pinned!]}</strong> · {pinnedList.length} position{pinnedList.length > 1 ? 's' : ''}
                    · total {pinnedList.reduce((a, [, v]) => a + v, 0).toFixed(2)}%
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPinned(null)}>✕ Fermer</button>
                </div>
                {pinnedList.some(([t]) => !colors.has(t)) && (
                  <div className={styles.muted} style={{ fontSize: '0.72rem', marginBottom: '0.4rem' }}>
                    Gris : titre regroupé dans « Autres » sur le graphique.
                  </div>
                )}
                {pinnedList.length === 0 ? (
                  <div className={styles.muted}>Tout en cash ce jour-là.</div>
                ) : (
                  <div className={`${styles.weightList} ${styles.evoPinnedList}`}>
                    {pinnedList.map(([t, v]) => (
                      <div key={t} className={styles.weightRow}>
                        <span className={styles.weightTicker}>{t}</span>
                        <span className={styles.weightBarTrack}>
                          <span className={styles.weightBar} style={{ width: `${Math.min(100, Math.max(0, v))}%`, background: colors.get(t) ?? GREY }} />
                        </span>
                        <span className={styles.num}>{v.toFixed(2)}%</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
