'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PriceHistory, PriceUpdate, StoredTicker } from '@/lib/engine/client';
import { useEngineStore } from '@/lib/engine/store';
import EChart from './charts/EChart';
import { CHART_COLORS } from './charts/echarts-setup';
import { movingAverage, type MaType } from './charts/moving-average';
import DataGrid, { type GridColumn } from './grid/DataGrid';
import { money } from './results/format';
import TickerQuoteCard, { bigMoney } from './TickerQuoteCard';
import styles from './Results.module.css';
import layout from './Backtester.module.css';

const UPDATE_CHUNK = 500;
const RANGES = [
  { id: '1A', years: 1 },
  { id: '5A', years: 5 },
  { id: '10A', years: 10 },
  { id: 'Max', years: 0 },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

const fmtInt = (n: number) => n.toLocaleString('fr-CA');
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)} %`);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function shiftYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Close on or before a date (dates are sorted ascending). */
function closeAt(h: PriceHistory, iso: string): number | null {
  let lo = 0;
  let hi = h.dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (h.dates[mid] <= iso) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found < 0 ? null : h.close[found];
}

function stats(h: PriceHistory) {
  const n = h.close.length;
  const last = h.close[n - 1];
  const lastDate = h.dates[n - 1];
  const change = (iso: string) => {
    const c = closeAt(h, iso);
    return c && iso >= h.dates[0] ? last / c - 1 : null;
  };
  const years = (Date.parse(lastDate) - Date.parse(h.dates[0])) / (365.25 * 864e5);
  const yearAgo = shiftYears(lastDate, 1);
  const div = h.dividends;
  let div12 = 0;
  if (div) for (let i = 0; i < div.dates.length; i++) if (div.dates[i] > yearAgo) div12 += div.amounts[i];
  let peak = -Infinity;
  let dd = 0;
  for (const c of h.close) {
    if (c > peak) peak = c;
    else dd = Math.min(dd, c / peak - 1);
  }
  return {
    last,
    m1: change(new Date(Date.parse(lastDate) - 30 * 864e5).toISOString().slice(0, 10)),
    ytd: change(`${Number(lastDate.slice(0, 4)) - 1}-12-31`),
    y1: change(yearAgo),
    cagr: years > 0.5 ? Math.pow(last / h.close[0], 1 / years) - 1 : null,
    divYield: div12 > 0 ? div12 / last : null,
    maxDd: dd,
  };
}

/** Every ticker the engine has ever downloaded: browse, chart and bring up to date. Stored histories work without internet. */
export default function TickersView() {
  const client = useEngineStore((s) => s.client);
  const [list, setList] = useState<StoredTicker[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  const [ticker, setTicker] = useState<string | null>(null);
  const [hist, setHist] = useState<PriceHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maType, setMaType] = useState<MaType>('SMA');
  const [ma1, setMa1] = useState(50);
  const [ma2, setMa2] = useState(200);
  const [log, setLog] = useState(false);
  const [candles, setCandles] = useState(false);
  const [range, setRange] = useState<RangeId>('Max');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stopRef = useRef(false);
  const loadSeq = useRef(0);

  const refreshList = useCallback(async () => {
    if (!client) return;
    setListError(null);
    try {
      setList(await client.storeTickers());
    } catch (e) {
      setListError(errText(e));
    }
  }, [client]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const load = useCallback(async (t: string, mode: PriceUpdate = 'stored') => {
    if (!client) return;
    const seq = ++loadSeq.current;
    setTicker(t);
    setLoading(true);
    setError(null);
    try {
      const h = await client.prices(t, null, mode, true);
      if (seq !== loadSeq.current) return;
      setHist(h);
      if (h.source !== 'job' && (mode !== 'stored' || h.source === 'download')) refreshList();
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setHist(null);
      setError(errText(e));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [client, refreshList]);

  const counts = useMemo(() => {
    if (!list) return null;
    let current = 0;
    let rows = 0;
    for (const t of list) {
      if (t.current) current++;
      rows += t.rows;
    }
    return { total: list.length, current, stale: list.length - current, rows };
  }, [list]);

  const rows = useMemo(() => {
    if (!list) return [];
    const q = search.trim().toUpperCase();
    return list.filter((t) => (!staleOnly || !t.current) && (!q || t.ticker.includes(q)));
  }, [list, search, staleOnly]);

  const columns = useMemo<GridColumn<StoredTicker>[]>(() => [
    { key: 'ticker', label: 'Ticker', width: 90, value: (r) => r.ticker },
    { key: 'name', label: 'Nom', width: 170, value: (r) => r.name ?? '' },
    { key: 'cap', label: 'Market cap', width: 96, align: 'right', title: 'Dernière fiche Yahoo archivée (actifs nets pour un fonds)', value: (r) => r.market_cap ?? null, format: (v) => bigMoney(v as number | null) },
    { key: 'pe', label: 'PER', width: 64, align: 'right', value: (r) => r.pe ?? null, format: (v) => (v === null || v === undefined ? '—' : (v as number).toFixed(1)) },
    { key: 'last', label: 'Dernier jour', width: 104, value: (r) => r.last },
    { key: 'first', label: 'Depuis', width: 96, value: (r) => r.first },
    { key: 'rows', label: 'Jours', width: 72, align: 'right', value: (r) => r.rows, format: (v) => fmtInt(v as number) },
    {
      key: 'state',
      label: 'État',
      width: 84,
      value: (r) => (r.current ? 'à jour' : 'pas à jour'),
      cellStyle: (_v, r) => ({ color: r.current ? 'var(--green)' : 'var(--orange, #f0a040)' }),
    },
  ], []);

  const updateStale = async () => {
    if (!client || !list) return;
    const stale = list.filter((t) => !t.current).map((t) => t.ticker);
    stopRef.current = false;
    const total = { topped: 0, refetched: 0, unchanged: 0, failed: 0 };
    try {
      for (let i = 0; i < stale.length && !stopRef.current; i += UPDATE_CHUNK) {
        setBusy(`Mise à jour ${fmtInt(i)} / ${fmtInt(stale.length)}…`);
        const r = await client.storeUpdate(stale.slice(i, i + UPDATE_CHUNK), 'topup');
        total.topped += r.topped_up;
        total.refetched += r.refetched;
        total.unchanged += r.unchanged;
        total.failed += r.failed ?? 0;
      }
      setNotice(
        `${fmtInt(total.topped)} complété(s) avec les jours récents · ${fmtInt(total.refetched)} retéléchargé(s) en entier (split ou correction Yahoo) · ${fmtInt(total.unchanged)} sans nouveau jour`
        + (total.failed ? ` · ${fmtInt(total.failed)} sans réponse de Yahoo (réessaie plus tard)` : '') + '.',
      );
    } catch (e) {
      setNotice(`Mise à jour interrompue : ${errText(e)}`);
    } finally {
      setBusy(null);
      refreshList();
      if (ticker) load(ticker);
    }
  };

  const redownload = async (t: string) => {
    if (!client) return;
    setBusy(`Retéléchargement de ${t}…`);
    try {
      await client.storeUpdate([t], 'full');
      await load(t);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const meta = ticker ? list?.find((t) => t.ticker === ticker) : undefined;
  const s = useMemo(() => (hist && hist.close.length ? stats(hist) : null), [hist]);

  const option = useMemo(() => {
    if (!hist || !hist.dates.length) return null;
    const a = movingAverage(hist.close, ma1, maType);
    const b = movingAverage(hist.close, ma2, maType);
    const years = RANGES.find((r) => r.id === range)?.years ?? 0;
    const start = years ? shiftYears(hist.dates[hist.dates.length - 1], years) : null;
    const startIndex = start ? Math.max(0, hist.dates.findIndex((d) => d >= start)) : 0;
    const lastOf = (arr: (number | null)[]) => arr[arr.length - 1];
    const bars = hist.bars;
    const name = `${hist.ticker} (${money(hist.close[hist.close.length - 1])})`;
    const price = candles && bars
      ? {
          name,
          type: 'candlestick',
          data: hist.close.map((c, i) => [bars.open[i] ?? c, c, bars.low[i] ?? c, bars.high[i] ?? c]),
          itemStyle: { color: CHART_COLORS.green, color0: '#ff6b7a', borderColor: CHART_COLORS.green, borderColor0: '#ff6b7a' },
          large: true,
        }
      : { name, type: 'line', data: hist.close, showSymbol: false, lineStyle: { width: 1.4, color: CHART_COLORS.accent }, sampling: 'lttb' };
    return {
      grid: bars
        ? [{ left: 64, right: 20, top: 40, bottom: 150 }, { left: 64, right: 20, height: 70, bottom: 50 }]
        : [{ left: 64, right: 20, top: 40, bottom: 60 }],
      legend: { top: 4 },
      tooltip: { trigger: 'axis', axisPointer: { link: [{ xAxisIndex: 'all' }] }, valueFormatter: (v: number | null) => (v === null || v === undefined ? '' : Number(v).toLocaleString('fr-CA', { maximumFractionDigits: 2 })) },
      xAxis: bars
        ? [
            { type: 'category', data: hist.dates, boundaryGap: candles, axisLabel: { show: false } },
            { type: 'category', data: hist.dates, boundaryGap: candles, gridIndex: 1 },
          ]
        : [{ type: 'category', data: hist.dates, boundaryGap: false }],
      yAxis: bars
        ? [
            { type: log ? 'log' : 'value', scale: true },
            { type: 'value', gridIndex: 1, splitNumber: 2, axisLabel: { formatter: (v: number) => (v >= 1e9 ? `${v / 1e9} G` : v >= 1e6 ? `${v / 1e6} M` : `${v}`) } },
          ]
        : [{ type: log ? 'log' : 'value', scale: true }],
      dataZoom: [
        { type: 'inside', startValue: startIndex, xAxisIndex: bars ? [0, 1] : [0] },
        { type: 'slider', height: 16, bottom: 10, startValue: startIndex, xAxisIndex: bars ? [0, 1] : [0] },
      ],
      series: [
        price,
        { name: `${maType} ${ma1}${lastOf(a) ? ` (${money(lastOf(a) as number)})` : ''}`, type: 'line', data: a, showSymbol: false, lineStyle: { width: 1.3, color: CHART_COLORS.orange }, sampling: 'lttb' },
        { name: `${maType} ${ma2}${lastOf(b) ? ` (${money(lastOf(b) as number)})` : ''}`, type: 'line', data: b, showSymbol: false, lineStyle: { width: 1.3, color: CHART_COLORS.green }, sampling: 'lttb' },
        ...(bars ? [{ name: 'Volume', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: bars.volume, itemStyle: { color: 'rgba(120,140,180,0.55)' }, large: true }] : []),
      ],
    };
  }, [hist, ma1, ma2, maType, log, range, candles]);

  const position = useMemo(() => {
    if (!hist || !hist.close.length) return null;
    const last = hist.close[hist.close.length - 1];
    const at = (w: number) => movingAverage(hist.close, w, maType).at(-1) ?? null;
    return [ma1, ma2].map((w) => {
      const m = at(w);
      return { w, gap: m ? last / m - 1 : null };
    });
  }, [hist, ma1, ma2, maType]);

  if (!client) {
    return <div className={`card ${styles.loadingCard}`}>Le moteur est hors ligne : la base de tickers est stockée dans le moteur, démarre-le pour la consulter.</div>;
  }

  return (
    <>
      <div className="card">
        <div className={styles.cardHead}>
          <div>
            <div className={styles.cardTitle}>Base de tickers</div>
            <div className={styles.cardSub}>
              Historiques complets gardés en permanence dans le moteur et réutilisés par tous les runs. Consultables sans internet.
            </div>
          </div>
          <div className={styles.toolbarInline}>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const t = search.trim().toUpperCase();
                if (t) load(t);
              }}
            >
              <input className="input" style={{ width: 200 }} placeholder="Chercher ou ajouter (Entrée)" value={search} onChange={(e) => setSearch(e.target.value)} />
            </form>
            <label className={styles.inlineCheck}>
              <input type="checkbox" checked={staleOnly} onChange={(e) => setStaleOnly(e.target.checked)} />
              Pas à jour seulement
            </label>
            <button type="button" className="btn btn-ghost btn-sm" onClick={refreshList} disabled={!!busy}>Actualiser</button>
            {busy ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => { stopRef.current = true; }}>{busy} · Arrêter</button>
            ) : (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={updateStale}
                disabled={!counts?.stale}
                title="Va chercher sur Yahoo seulement les jours manquants de chaque ticker pas à jour (vérifie aussi les splits)"
              >
                Compléter les tickers pas à jour{counts?.stale ? ` (${fmtInt(counts.stale)})` : ''}
              </button>
            )}
          </div>
        </div>
        {counts && (
          <div className={styles.kpis}>
            <div><span>Tickers stockés</span><strong>{fmtInt(counts.total)}</strong></div>
            <div><span>À jour</span><strong style={{ color: 'var(--green)' }}>{fmtInt(counts.current)}</strong></div>
            <div><span>Pas à jour</span><strong>{fmtInt(counts.stale)}</strong></div>
            <div><span>Jours de cotation</span><strong>{fmtInt(counts.rows)}</strong></div>
          </div>
        )}
        {notice && <div className={styles.padded}>{notice}</div>}
        {listError && <div className={styles.padded}>{listError}</div>}
      </div>

      <div className={layout.tickersLayout}>
        <div className="card">
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(r) => r.ticker}
            maxHeight={620}
            initialSort={{ key: 'ticker', dir: 'asc' }}
            onRowClick={(r) => load(r.ticker)}
            selectedKey={ticker}
            csvName="base-tickers"
            empty={list ? (search ? `Aucun ticker stocké ne contient « ${search} ». Entrée pour le télécharger.` : 'Aucun ticker stocké : lance un backtest ou ajoute un ticker.') : 'Chargement…'}
          />
        </div>

        <div className={layout.tickersRight}>
        <div className="card">
          <div className={styles.cardHead}>
            <div>
              <div className={styles.cardTitle}>{ticker ?? 'Choisis un ticker'}</div>
              <div className={styles.cardSub}>
                {hist
                  ? `${hist.dates[0]} → ${hist.dates[hist.dates.length - 1]} · ${fmtInt(hist.dates.length)} jours · clôture ajustée des splits (pas des dividendes)${meta && !meta.current ? ' · pas à jour' : ''}`
                  : 'Clique un ticker dans la liste'}
              </div>
            </div>
            <div className={styles.toolbarInline}>
              <div className={styles.segment}>
                {RANGES.map((r) => (
                  <button key={r.id} type="button" className={range === r.id ? styles.segOn : ''} onClick={() => setRange(r.id)}>{r.id}</button>
                ))}
              </div>
              <div className={styles.segment}>
                {(['SMA', 'EMA'] as MaType[]).map((t) => (
                  <button key={t} type="button" className={maType === t ? styles.segOn : ''} onClick={() => setMaType(t)}>{t}</button>
                ))}
              </div>
              <label className={styles.inlineField}>
                MM
                <input type="number" className="input" style={{ width: 70 }} min={2} max={2000} value={ma1} onChange={(e) => setMa1(Math.max(2, Number(e.target.value) || 50))} />
                <input type="number" className="input" style={{ width: 70 }} min={2} max={2000} value={ma2} onChange={(e) => setMa2(Math.max(2, Number(e.target.value) || 200))} />
              </label>
              <label className={styles.inlineCheck}>
                <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />
                Log
              </label>
              {hist?.bars && (
                <label className={styles.inlineCheck} title="Ouverture, haut, bas, clôture de chaque jour (plus lisible sur 1 an ou moins)">
                  <input type="checkbox" checked={candles} onChange={(e) => setCandles(e.target.checked)} />
                  Bougies
                </label>
              )}
              {ticker && (
                <>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy || loading} onClick={() => load(ticker, 'topup')} title="Ajoute seulement les jours manquants depuis Yahoo">
                    Compléter
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy || loading} onClick={() => redownload(ticker)} title="Retélécharge tout l'historique depuis Yahoo">
                    Retélécharger
                  </button>
                </>
              )}
            </div>
          </div>
          {s && (
            <div className={styles.kpis}>
              <div><span>Dernière clôture</span><strong>{money(s.last)}</strong></div>
              <div><span>1 mois</span><strong>{pct(s.m1)}</strong></div>
              <div><span>Depuis janvier</span><strong>{pct(s.ytd)}</strong></div>
              <div><span>1 an</span><strong>{pct(s.y1)}</strong></div>
              <div><span>Croissance annuelle (prix)</span><strong>{pct(s.cagr)}</strong></div>
              <div><span>Pire baisse</span><strong>{pct(s.maxDd)}</strong></div>
              <div><span>Dividendes 12 mois</span><strong>{s.divYield === null ? '—' : `${(s.divYield * 100).toFixed(2)} %`}</strong></div>
              {position?.map((p) => (
                <div key={p.w}><span>vs {maType} {p.w}</span><strong style={{ color: p.gap === null ? undefined : p.gap >= 0 ? 'var(--green)' : 'var(--red, #ff6b7a)' }}>{pct(p.gap)}</strong></div>
              ))}
            </div>
          )}
          {loading ? (
            <div className={styles.padded}>Chargement…</div>
          ) : error ? (
            <div className={styles.padded}>{error}</div>
          ) : option ? (
            <EChart option={option} height={hist?.bars ? 560 : 460} />
          ) : (
            <div className={styles.padded}>Aucune donnée.</div>
          )}
        </div>
        {ticker && <TickerQuoteCard client={client} ticker={ticker} canRefresh />}
        </div>
      </div>
    </>
  );
}
