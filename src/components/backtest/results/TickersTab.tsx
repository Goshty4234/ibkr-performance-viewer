'use client';

import { useEffect, useMemo, useState } from 'react';
import { dateWindow, pctVersus, windowStats } from '@/lib/backtest/price-window';
import type { PriceHistory } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import type { LoadedResult } from '@/lib/backtest/result-data';
import type { PortfolioSummaryOk } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import { CHART_COLORS } from '../charts/echarts-setup';
import { movingAverage, type MaType } from '../charts/moving-average';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
import { money, num } from './format';
import PeEvolution from './PeEvolution';
import styles from '../Results.module.css';

const signedPct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} %`);

function jobIdOf(result: LoadedResult): string | undefined {
  return result.key.startsWith('job:') ? result.key.slice(4) : undefined;
}

export default function TickersTab({ result, portfolios }: { result: LoadedResult; portfolios: PortfolioSummaryOk[] }) {
  const client = useEngineStore((s) => s.client);
  const tickers = useMemo(() => {
    const set = new Set<string>();
    for (const p of portfolios) for (const s of p.config.stocks ?? []) if (s.ticker) set.add(s.ticker);
    return [...set].sort();
  }, [portfolios]);
  const firstMa = portfolios.find((p) => p.config.use_sma_filter || p.config.ma_cross_rebalance)?.config;
  const [ticker, setTicker] = useState(tickers[0] ?? '');
  const [custom, setCustom] = useState('');
  const [window, setWindow] = useState<number>(Number(firstMa?.sma_window) || 200);
  const [maType, setMaType] = useState<MaType>((firstMa?.ma_type as MaType) === 'EMA' ? 'EMA' : 'SMA');
  const [log, setLog] = useState(false);
  const [view, setView] = useState<'price' | 'pct'>('price');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [hist, setHist] = useState<PriceHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pe, setPe] = useState<Record<string, number | null> | null>(null);
  const [peLoading, setPeLoading] = useState(false);
  const [peError, setPeError] = useState<string | null>(null);

  useEffect(() => {
    if (!ticker || !client) return;
    let alive = true;
    setLoading(true);
    setError(null);
    client.prices(ticker, jobIdOf(result)).then(
      (h) => alive && (setHist(h), setLoading(false)),
      (e: unknown) => alive && (setHist(null), setLoading(false), setError(e instanceof Error ? e.message : String(e))),
    );
    return () => {
      alive = false;
    };
  }, [ticker, client, result]);

  const ranged = !!(from || to);
  /** Days shown: the dates typed in, otherwise the whole history. */
  const win = useMemo(() => {
    if (!hist || !hist.dates.length) return null;
    return ranged ? dateWindow(hist.dates, from, to) : { start: 0, end: hist.dates.length - 1 };
  }, [hist, ranged, from, to]);
  const rangeStats = useMemo(() => (hist && win ? windowStats(hist.close, win) : null), [hist, win]);
  /** Dates of the run itself, to look at a ticker over exactly the backtested period. */
  const runDates = result.summary.dates;
  const runFrom = runDates[0] ?? '';
  const runTo = runDates[runDates.length - 1] ?? '';

  const option = useMemo(() => {
    if (!hist || !hist.dates.length || !win) return null;
    const ma = movingAverage(hist.close, window, maType);
    if (view === 'pct') {
      // Same chart as the price one, as % change from the first day of the window (0 % there).
      const base = hist.close[win.start];
      const cut = (arr: (number | null)[]) => pctVersus(arr.slice(win.start, win.end + 1), base);
      const closeP = cut(hist.close);
      const maP = cut(ma);
      const lastPct = closeP[closeP.length - 1];
      const lastMaPct = maP[maP.length - 1];
      return {
        grid: { left: 64, right: 20, top: 40, bottom: 60 },
        legend: { top: 4 },
        tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v === null || v === undefined ? '' : `${Number(v).toFixed(2)} %`) },
        xAxis: { type: 'category', data: hist.dates.slice(win.start, win.end + 1), boundaryGap: false },
        yAxis: { type: 'value', scale: true, axisLabel: { formatter: (v: number) => `${v} %` } },
        dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
        series: [
          {
            name: `${hist.ticker}${lastPct === null ? '' : ` (${signedPct(lastPct / 100)})`}`,
            type: 'line',
            data: closeP,
            showSymbol: false,
            lineStyle: { width: 1.4, color: CHART_COLORS.accent },
            sampling: 'lttb',
            markLine: { silent: true, symbol: 'none', label: { show: false }, lineStyle: { color: CHART_COLORS.faint, type: 'dashed' }, data: [{ yAxis: 0 }] },
          },
          { name: `${maType} ${window}${lastMaPct === null ? '' : ` (${signedPct(lastMaPct / 100)})`}`, type: 'line', data: maP, showSymbol: false, lineStyle: { width: 1.4, color: CHART_COLORS.orange }, sampling: 'lttb' },
        ],
      };
    }
    const lastClose = hist.close[hist.close.length - 1];
    const lastMa = ma[ma.length - 1];
    return {
      grid: { left: 64, right: 20, top: 40, bottom: 60 },
      legend: { top: 4 },
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v === null || v === undefined ? '' : v.toFixed(2)) },
      xAxis: { type: 'category', data: hist.dates, boundaryGap: false },
      yAxis: { type: log ? 'log' : 'value', scale: true },
      dataZoom: ranged
        ? [{ type: 'inside', startValue: win.start, endValue: win.end }, { type: 'slider', height: 16, bottom: 10, startValue: win.start, endValue: win.end }]
        : [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 10 }],
      series: [
        { name: `${hist.ticker} (${money(lastClose)})`, type: 'line', data: hist.close, showSymbol: false, lineStyle: { width: 1.4, color: CHART_COLORS.accent }, sampling: 'lttb' },
        { name: `${maType} ${window}${lastMa ? ` (${money(lastMa)})` : ''}`, type: 'line', data: ma, showSymbol: false, lineStyle: { width: 1.4, color: CHART_COLORS.orange }, sampling: 'lttb' },
      ],
    };
  }, [hist, window, maType, log, win, view, ranged]);

  const status = useMemo(() => {
    if (!hist || !hist.close.length) return null;
    const ma = movingAverage(hist.close, window, maType);
    const c = hist.close[hist.close.length - 1];
    const m = ma[ma.length - 1];
    if (m === null) return null;
    return { above: c >= m, gap: (c / m - 1) * 100 };
  }, [hist, window, maType]);

  const loadPe = async () => {
    if (!client) return;
    setPeLoading(true);
    setPeError(null);
    try {
      setPe(await client.peRatios(tickers));
    } catch (e) {
      setPeError(e instanceof Error ? e.message : String(e));
    } finally {
      setPeLoading(false);
    }
  };

  type PeRow = { t: string; pe: number | null; weights: number[] };
  const peRows = useMemo<PeRow[]>(() => {
    if (!pe) return [];
    return tickers.map((t) => ({ t, pe: pe[t] ?? null, weights: portfolios.map((p) => p.today_weights?.[t] ?? 0) }));
  }, [pe, tickers, portfolios]);
  const peCols = useMemo<GridColumn<PeRow>[]>(() => [
    { key: 't', label: 'Ticker', width: 100, value: (r) => r.t },
    { key: 'pe', label: 'PER (trailing)', width: 130, align: 'right', value: (r) => r.pe, format: (v) => num(v as number) },
  ], []);
  const weightedPe = useMemo(() => {
    if (!pe) return [];
    return portfolios.map((p) => {
      let w = 0;
      let inv = 0;
      for (const [t, wt] of Object.entries(p.today_weights ?? {})) {
        const v = pe[t];
        if (t === 'CASH' || !v || v <= 0 || !(wt > 0)) continue;
        w += wt;
        inv += wt / v;
      }
      return { index: p.index, name: p.name, pe: inv > 0 ? w / inv : null, coverage: w * 100 };
    });
  }, [pe, portfolios]);

  if (!client) {
    return <div className={`card ${styles.loadingCard}`}>Le moteur est hors ligne : les prix des tickers ne peuvent pas être chargés.</div>;
  }

  return (
    <>
      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>Prix et moyenne mobile</div>
            <div className={styles.cardSub}>
              {hist ? `${hist.dates[0]} → ${hist.dates[hist.dates.length - 1]} · source ${hist.source === 'job' ? 'données du run' : hist.source === 'store' ? 'base de tickers' : 'téléchargement'}` : 'Historique de clôture ajustée'}
            </div>
          </div>
          <div className={styles.toolbarInline}>
            <select className={styles.select} value={ticker} onChange={(e) => setTicker(e.target.value)}>
              {tickers.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (custom.trim()) setTicker(custom.trim().toUpperCase());
              }}
            >
              <input className="input" style={{ width: 110 }} placeholder="Autre ticker" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </form>
            <label className={styles.inlineField}>
              Du
              <input type="date" className="input" value={from} min={hist?.dates[0]} max={hist?.dates[hist.dates.length - 1]} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className={styles.inlineField}>
              Au
              <input type="date" className="input" value={to} min={hist?.dates[0]} max={hist?.dates[hist.dates.length - 1]} onChange={(e) => setTo(e.target.value)} />
            </label>
            {runFrom && (
              <button type="button" className="btn btn-ghost btn-sm" title="Affiche le ticker sur les dates du backtest" onClick={() => { setFrom(runFrom); setTo(runTo); }}>
                Période du run
              </button>
            )}
            {ranged && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setFrom(''); setTo(''); }}>Effacer les dates</button>
            )}
            <div className={styles.segment}>
              <button type="button" className={view === 'price' ? styles.segOn : ''} onClick={() => setView('price')} title="Cours de clôture en $">Prix $</button>
              <button type="button" className={view === 'pct' ? styles.segOn : ''} onClick={() => setView('pct')} title="Variation en % depuis le premier jour de la plage (0 % au départ)">Variation %</button>
            </div>
            <div className={styles.segment}>
              {(['SMA', 'EMA'] as MaType[]).map((t) => (
                <button key={t} type="button" className={maType === t ? styles.segOn : ''} onClick={() => setMaType(t)}>{t}</button>
              ))}
            </div>
            <label className={styles.inlineField}>
              Fenêtre
              <input type="number" className="input" style={{ width: 80 }} min={2} max={2000} value={window} onChange={(e) => setWindow(Math.max(2, Number(e.target.value) || 200))} />
            </label>
            <label className={styles.inlineCheck}>
              <input type="checkbox" checked={log} disabled={view === 'pct'} onChange={(e) => setLog(e.target.checked)} />
              Log
            </label>
          </div>
        </div>
        {(status || rangeStats) && (
          <div className={styles.kpis}>
            {status && (
              <>
                <div><span>Position vs {maType} {window}</span><strong style={{ color: status.above ? 'var(--green)' : 'var(--red, #ff6b7a)' }}>{status.above ? 'Au-dessus' : 'En dessous'}</strong></div>
                <div><span>Écart</span><strong>{status.gap.toFixed(2)}%</strong></div>
              </>
            )}
            {rangeStats && win && hist && (
              <>
                <div title={`${hist.dates[win.start]} → ${hist.dates[win.end]}`}><span>Variation {ranged ? 'sur la plage' : 'totale'}</span><strong>{signedPct(rangeStats.change)}</strong></div>
                <div><span>Pire baisse {ranged ? 'sur la plage' : 'totale'}</span><strong>{signedPct(rangeStats.maxDrawdown)}</strong></div>
              </>
            )}
          </div>
        )}
        {loading ? (
          <div className={styles.padded}>Chargement…</div>
        ) : error ? (
          <div className={styles.padded}>{error}</div>
        ) : option ? (
          <EChart option={option} height={420} />
        ) : (
          <div className={styles.padded}>{hist && ranged && !win ? 'Aucun jour de cotation dans cette plage de dates.' : 'Aucune donnée.'}</div>
        )}
      </div>

      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>Ratios cours / bénéfices</div>
            <div className={styles.cardSub}>PER trailing des tickers et PER pondéré (moyenne harmonique) de l&apos;allocation d&apos;aujourd&apos;hui</div>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={loadPe} disabled={peLoading}>
            {peLoading ? 'Chargement…' : pe ? 'Rafraîchir' : `Charger les PER (${tickers.length})`}
          </button>
        </div>
        {peError && <div className={styles.padded}>{peError}</div>}
        {pe && (
          <div className={styles.compareGrid}>
            <div>
              <div className={styles.subTitle}>Par ticker</div>
              <DataGrid columns={peCols} rows={peRows} rowKey={(r) => r.t} maxHeight={380} csvName="per-tickers" />
            </div>
            <div>
              <div className={styles.subTitle}>PER pondéré par portfolio</div>
              <DataGrid
                columns={[
                  { key: 'name', label: 'Portfolio', width: 220, value: (r) => r.name },
                  { key: 'pe', label: 'PER pondéré', width: 120, align: 'right', value: (r) => r.pe, format: (v) => num(v as number) },
                  { key: 'cov', label: 'Couverture', width: 110, align: 'right', value: (r) => r.coverage, format: (v) => `${num(v as number, 1)}%` },
                ]}
                rows={weightedPe}
                rowKey={(r) => r.index}
                maxHeight={380}
                csvName="per-portfolios"
              />
            </div>
          </div>
        )}
      </div>
      {pe && <PeEvolution result={result} portfolios={portfolios} pe={pe} />}
    </>
  );
}
