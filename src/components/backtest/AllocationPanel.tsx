'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import { SERIES_PALETTE } from '@/lib/chart-series';
import type { PortfolioDetail, PortfolioSummaryOk } from '@/lib/engine/types';
import PeriodFields from './results/PeriodFields';
import styles from './Results.module.css';

const MAX_AREA_TICKERS = 16;
const OTHERS = 'Autres';
const PAINT_MAX = 480;
const ALLOC_Y = 44;
const ALLOC_RIGHT = 8;
const OTHERS_COLOR = '#9aa8bc';

/** Engine weights are fractions (0..1); tolerate percentage inputs. */
function asPct(weights: Record<string, number>): Record<string, number> {
  const vals = Object.values(weights).filter((v) => Number.isFinite(v));
  const sum = vals.reduce((a, b) => a + b, 0);
  const factor = sum > 1.5 ? 1 : 100;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, (Number.isFinite(v) ? v : 0) * factor]));
}

interface Evolution {
  dates: string[];
  weights: Record<string, (number | null)[]>;
  factor: number;
}

interface EvolutionView {
  /** First index of the window inside `Evolution.dates`. */
  i0: number;
  /** One entry per simulated day in the window. The painted chart is a sample of these. */
  count: number;
  keys: string[];
  paint: Record<string, number | string | [number, number]>[];
}

const EMPTY_EVOLUTION: Evolution = { dates: [], weights: {}, factor: 100 };
const EMPTY_VIEW: EvolutionView = { i0: 0, count: 0, keys: [], paint: [] };
const GREY = '#5c6d85';

/** Stocks with a real weight that day. Cash is not a stock. */
function heldCount(ev: Evolution, i: number): number {
  let n = 0;
  for (const [t, series] of Object.entries(ev.weights)) {
    if (t === 'CASH') continue;
    if ((series[i] ?? 0) * ev.factor > 0.05) n += 1;
  }
  return n;
}

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

function paintIndices(n: number): number[] {
  if (n <= PAINT_MAX) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (PAINT_MAX - 1);
  const out: number[] = [];
  let prev = -1;
  for (let k = 0; k < PAINT_MAX; k++) {
    const i = Math.round(k * step);
    if (i !== prev) out.push(i);
    prev = i;
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

/** Bands follow the largest weights reached inside the window, including names that have since left. The rest fills up to 100 %. */
function buildView(ev: Evolution, start: string, end: string): EvolutionView {
  if (!ev.dates.length) return EMPTY_VIEW;
  const i0 = start ? ev.dates.findIndex((d) => d >= start) : 0;
  const i1 = end ? indexOnOrBefore(ev.dates, end) : ev.dates.length - 1;
  if (i0 < 0 || i1 < i0) return EMPTY_VIEW;
  const ranked = Object.keys(ev.weights).map((t) => {
    let peak = 0;
    const series = ev.weights[t];
    for (let i = i0; i <= i1; i++) {
      const v = series[i] ?? 0;
      if (v > peak) peak = v;
    }
    return { t, peak };
  }).filter((x) => x.peak > 0).sort((a, b) => b.peak - a.peak);
  const top = ranked.slice(0, MAX_AREA_TICKERS).map((x) => x.t);
  if (!top.length) return EMPTY_VIEW;
  const keys = [...top, OTHERS];
  const count = i1 - i0 + 1;
  const paint: Record<string, number | string | [number, number]>[] = [];
  for (const local of paintIndices(count)) {
    const i = i0 + local;
    const row: Record<string, number | string | [number, number]> = { date: ev.dates[i], n: heldCount(ev, i) };
    // Explicit [bottom, top] bands. Recharts' own stack with stepAfter collapses
    // toward 0 even when the day has real weights.
    let floor = 0;
    for (const t of top) {
      const v = Math.max(0, (ev.weights[t][i] ?? 0) * ev.factor);
      row[t] = [floor, floor + v];
      floor += v;
    }
    const rest = Math.max(0, 100 - floor);
    row[OTHERS] = [floor, floor + rest];
    paint.push(row);
  }
  return { i0, count, keys, paint };
}

function buildEvolution(d: PortfolioDetail): Evolution {
  const { dates, weights } = d.allocations ?? { dates: [], weights: {} };
  const tickers = Object.keys(weights);
  if (!dates.length || !tickers.length) return EMPTY_EVOLUTION;
  let sample = 0;
  for (const t of tickers) for (const v of weights[t]) if (v !== null && Number.isFinite(v)) sample = Math.max(sample, v);
  return { dates, weights, factor: sample > 1.5 ? 1 : 100 };
}

function allocIndex(clientX: number, rect: DOMRect, n: number): number {
  if (n < 2) return 0;
  const plot = rect.width - ALLOC_Y - ALLOC_RIGHT;
  const x = clientX - rect.left - ALLOC_Y;
  const ratio = Math.max(0, Math.min(1, x / Math.max(plot, 1)));
  return Math.round(ratio * (n - 1));
}

function allocX(index: number, rect: DOMRect, n: number): number {
  if (n < 2) return ALLOC_Y;
  const plot = rect.width - ALLOC_Y - ALLOC_RIGHT;
  return ALLOC_Y + (index / (n - 1)) * plot;
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
  const view = useMemo(() => buildView(evolution, start, end), [evolution, start, end]);
  const colors = useMemo(
    () => new Map(view.keys.map((k, i) => [k, k === OTHERS ? OTHERS_COLOR : k === 'CASH' ? GREY : SERIES_PALETTE[i % SERIES_PALETTE.length]])),
    [view],
  );
  const plotRef = useRef<HTMLDivElement>(null);
  const lineRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const countPlotRef = useRef<HTMLDivElement>(null);
  const countLineRef = useRef<HTMLDivElement>(null);
  const countTipRef = useRef<HTMLDivElement>(null);
  const allocSnap = useRef({ evolution, view, colors });
  allocSnap.current = { evolution, view, colors };
  const allocPending = useRef<number | null>(null);
  const allocFrame = useRef(0);
  const allocLast = useRef(-1);
  useEffect(() => () => { if (allocFrame.current) cancelAnimationFrame(allocFrame.current); }, []);
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

  const paintAlloc = () => {
    const line = lineRef.current;
    const tip = tipRef.current;
    const list = listRef.current;
    const node = plotRef.current;
    const countLine = countLineRef.current;
    const countTip = countTipRef.current;
    const countNode = countPlotRef.current;
    const local = allocPending.current;
    if (!line || !tip || !list || !node) return;
    if (local === null) {
      line.hidden = true;
      tip.hidden = true;
      if (countLine) countLine.hidden = true;
      if (countTip) countTip.hidden = true;
      allocLast.current = -1;
      return;
    }
    const { evolution: ev, view: vw, colors: cols } = allocSnap.current;
    const origin = vw.i0 + local;
    const left = allocX(local, node.getBoundingClientRect(), vw.count);
    line.hidden = false;
    tip.hidden = false;
    line.style.left = `${left}px`;
    tip.style.left = `${left}px`;
    tip.style.transform = left > node.clientWidth * 0.62 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
    if (countLine && countTip && countNode) {
      const cleft = allocX(local, countNode.getBoundingClientRect(), vw.count);
      countLine.hidden = false;
      countTip.hidden = false;
      countLine.style.left = `${cleft}px`;
      countTip.style.left = `${cleft}px`;
      countTip.style.transform = cleft > countNode.clientWidth * 0.62 ? 'translateX(calc(-100% - 14px))' : 'translateX(14px)';
    }
    if (local === allocLast.current) return;
    allocLast.current = local;
    const rows = compositionAt(ev, origin);
    const nHeld = heldCount(ev, origin);
    const actionLabel = `${nHeld} action${nHeld === 1 ? '' : 's'}`;
    if (countTip) countTip.textContent = `${ev.dates[origin] ?? ''} · ${actionLabel}`;
    if (headRef.current) {
      headRef.current.textContent = `${ev.dates[origin] ?? ''} · ${actionLabel}`;
    }
    if (list.childElementCount !== rows.length) {
      const scroll = list.scrollTop;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < rows.length; i++) {
        const row = document.createElement('div');
        row.className = styles.evoTipRow;
        row.append(document.createElement('i'), document.createElement('span'), document.createElement('strong'));
        frag.append(row);
      }
      list.replaceChildren(frag);
      list.scrollTop = scroll;
    }
    for (let i = 0; i < rows.length; i++) {
      const row = list.children[i] as HTMLElement;
      const [t, v] = rows[i];
      (row.children[0] as HTMLElement).style.background = cols.get(t) ?? GREY;
      const label = `${v.toFixed(2)}%`;
      if (row.children[1].textContent !== t) row.children[1].textContent = t;
      if (row.children[2].textContent !== label) row.children[2].textContent = label;
    }
  };

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
            chaque jour détenu · les bandes sont les plus gros poids de la période, le reste est « Autres » · la liste se scrolle
          </span>
        </div>
        {loading ? (
          <div className={styles.muted}>Chargement du détail…</div>
        ) : error ? (
          <div className={styles.muted}>{error}</div>
        ) : view.count < 2 ? (
          <div className={styles.muted}>Pas d&apos;historique d&apos;allocation sur cette période.</div>
        ) : (
          <>
            <div
              className={styles.evoPlot}
              data-evo-plot=""
              ref={plotRef}
              onMouseMove={(e) => {
                if ((e.target as HTMLElement).closest('[data-evo-tip]')) return;
                const rect = plotRef.current?.getBoundingClientRect();
                if (!rect) return;
                allocPending.current = allocIndex(e.clientX, rect, view.count);
                if (allocFrame.current) return;
                allocFrame.current = requestAnimationFrame(() => { allocFrame.current = 0; paintAlloc(); });
              }}
              onMouseLeave={(e) => {
                const next = e.relatedTarget;
                if (next instanceof Element && (next.closest('[data-evo-tip]') || next.closest('[data-count-plot]'))) return;
                allocPending.current = null;
                paintAlloc();
              }}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('[data-evo-tip]')) return;
                const rect = plotRef.current?.getBoundingClientRect();
                if (!rect) return;
                setPinned(view.i0 + allocIndex(e.clientX, rect, view.count));
              }}
            >
              <ResponsiveContainer width="100%" height={360}>
                <AreaChart data={view.paint} margin={{ top: 8, right: ALLOC_RIGHT, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date" stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={48} tickFormatter={(d: string) => d.slice(0, 7)} />
                  <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} stroke="#5c6d85" fontSize={11} tickLine={false} axisLine={false} width={ALLOC_Y} />
                  {view.keys.map((k) => (
                    <Area
                      key={k}
                      type="stepAfter"
                      dataKey={k}
                      stroke="none"
                      fill={colors.get(k)}
                      fillOpacity={k === OTHERS ? 0.72 : 0.9}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
              <div ref={lineRef} className={styles.evoLine} hidden />
              <div ref={tipRef} className={styles.evoTip} data-evo-tip="" hidden>
                <div ref={headRef} className={styles.evoTipHead} />
                <div ref={listRef} className={styles.evoTipScroll} />
              </div>
            </div>
            <div className={styles.countHead}>
              <div className={styles.subTitle}>
                Nombre d&apos;actions
                <span className={styles.muted} style={{ fontWeight: 400, marginLeft: 8 }}>
                  titres qui ont un poids ce jour-là · le cash n&apos;est pas compté
                </span>
              </div>
            </div>
            <div
              className={styles.countPlot}
              data-count-plot=""
              ref={countPlotRef}
              onMouseMove={(e) => {
                const rect = countPlotRef.current?.getBoundingClientRect();
                if (!rect) return;
                allocPending.current = allocIndex(e.clientX, rect, view.count);
                if (allocFrame.current) return;
                allocFrame.current = requestAnimationFrame(() => { allocFrame.current = 0; paintAlloc(); });
              }}
              onMouseLeave={(e) => {
                const next = e.relatedTarget;
                if (next instanceof Element && (next.closest('[data-evo-plot]') || next.closest('[data-evo-tip]'))) return;
                allocPending.current = null;
                paintAlloc();
              }}
            >
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={view.paint} margin={{ top: 8, right: ALLOC_RIGHT, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date" stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={48} tickFormatter={(d: string) => d.slice(0, 7)} />
                  <YAxis allowDecimals={false} stroke="#5c6d85" fontSize={11} tickLine={false} axisLine={false} width={ALLOC_Y} />
                  <Line type="stepAfter" dataKey="n" stroke="#4d8dff" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
              <div ref={countLineRef} className={styles.evoLine} hidden />
              <div ref={countTipRef} className={styles.countTip} hidden />
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
