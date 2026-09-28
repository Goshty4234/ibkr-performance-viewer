'use client';

import { useMemo, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { LoadedResult } from '@/lib/backtest/result-data';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import { SERIES_PALETTE } from '@/lib/chart-series';
import type { PortfolioDetail, PortfolioSummaryOk } from '@/lib/engine/types';
import styles from './Results.module.css';

const MAX_AREA_TICKERS = 12;
const MAX_AREA_POINTS = 700;
const OTHERS = 'Autres';

/** Engine weights are fractions (0..1); tolerate percentage inputs. */
function asPct(weights: Record<string, number>): Record<string, number> {
  const vals = Object.values(weights).filter((v) => Number.isFinite(v));
  const sum = vals.reduce((a, b) => a + b, 0);
  const factor = sum > 1.5 ? 1 : 100;
  return Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, (Number.isFinite(v) ? v : 0) * factor]));
}

function buildEvolution(d: PortfolioDetail) {
  const { dates, weights } = d.allocations ?? { dates: [], weights: {} };
  const tickers = Object.keys(weights);
  if (!dates.length || !tickers.length) return { rows: [], keys: [] as string[] };

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

  const step = Math.max(1, Math.ceil(dates.length / MAX_AREA_POINTS));
  const rows: Record<string, number | string>[] = [];
  for (let i = 0; i < dates.length; i += step) {
    const row: Record<string, number | string> = { date: dates[i] };
    for (const t of top) row[t] = (weights[t][i] ?? 0) * factor;
    if (rest.length) {
      let o = 0;
      for (const t of rest) o += weights[t][i] ?? 0;
      row[OTHERS] = o * factor;
    }
    rows.push(row);
  }
  return { rows, keys };
}

export default function AllocationPanel({
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
  const [showAll, setShowAll] = useState(false);
  const { detail, loading, error } = usePortfolioDetail(result, p?.index ?? null);

  const today = useMemo(() => {
    if (!p) return [];
    const src = Object.keys(p.today_weights ?? {}).length ? p.today_weights : (p.current_alloc ?? {});
    return Object.entries(asPct(src))
      .filter(([, v]) => Math.abs(v) > 1e-9)
      .sort((a, b) => b[1] - a[1]);
  }, [p]);

  const evolution = useMemo(() => (detail ? buildEvolution(detail) : { rows: [], keys: [] }), [detail]);

  if (!p) return null;
  const visible = showAll ? today : today.slice(0, 25);
  const total = today.reduce((a, [, v]) => a + v, 0);

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Allocations</div>
          <div className={styles.cardSub}>
            Dernier rebalancement : {p.last_rebalance_date ?? 'N/A'}
            {detail?.metrics?.truncated && ' · historique des métriques tronqué'}
          </div>
        </div>
        <select className={styles.select} value={p.index} onChange={(e) => onSelect(Number(e.target.value))}>
          {portfolios.map((x) => <option key={x.index} value={x.index}>{x.name}</option>)}
        </select>
      </div>

      <div className={styles.allocGrid}>
        <div>
          <div className={styles.subTitle}>Poids cibles aujourd&apos;hui</div>
          {today.length === 0 ? (
            <div className={styles.muted}>Aucune allocation (cash ou données insuffisantes).</div>
          ) : (
            <>
              <div className={styles.weightList}>
                {visible.map(([t, v], i) => (
                  <div key={t} className={styles.weightRow}>
                    <span className={styles.weightTicker}>{t}</span>
                    <span className={styles.weightBarTrack}>
                      <span
                        className={styles.weightBar}
                        style={{ width: `${Math.min(100, Math.max(0, v))}%`, background: SERIES_PALETTE[i % SERIES_PALETTE.length] }}
                      />
                    </span>
                    <span className={styles.num}>{v.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
              <div className={styles.weightFoot}>
                <span>{today.length} positions · total {total.toFixed(2)}%</span>
                {today.length > 25 && (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAll((s) => !s)}>
                    {showAll ? 'Réduire' : `Tout afficher (${today.length})`}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        <div>
          <div className={styles.subTitle}>Évolution des allocations</div>
          {loading ? (
            <div className={styles.muted}>Chargement du détail…</div>
          ) : error ? (
            <div className={styles.muted}>{error}</div>
          ) : evolution.rows.length < 2 ? (
            <div className={styles.muted}>Pas d&apos;historique d&apos;allocation.</div>
          ) : (
            <div style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={evolution.rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="date" stroke="#5c6d85" fontSize={11} tickLine={false} minTickGap={48} tickFormatter={(d: string) => d.slice(0, 7)} />
                  <YAxis domain={[0, 100]} allowDataOverflow tickFormatter={(v) => `${v}%`} stroke="#5c6d85" fontSize={11} tickLine={false} axisLine={false} width={44} />
                  <Tooltip
                    formatter={(v: number) => `${v.toFixed(2)}%`}
                    contentStyle={{ background: '#141c2b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                    itemSorter={(it) => -(Number(it.value) || 0)}
                  />
                  {evolution.keys.map((k, i) => (
                    <Area
                      key={k}
                      type="stepAfter"
                      dataKey={k}
                      stackId="1"
                      stroke={k === OTHERS ? '#5c6d85' : SERIES_PALETTE[i % SERIES_PALETTE.length]}
                      fill={k === OTHERS ? '#5c6d85' : SERIES_PALETTE[i % SERIES_PALETTE.length]}
                      fillOpacity={0.55}
                      isAnimationActive={false}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
