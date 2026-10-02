'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ChartsResult, PeriodsResult } from '@/lib/backtest/analytics';
import { STAT_COLUMNS, fmtMoney, portfolioColor } from '@/lib/backtest/chart-data';
import { loadRun, type BacktestRunRow } from '@/lib/backtest/history';
import { okSummaries, type LoadedResult } from '@/lib/backtest/result-data';
import { FREQUENCY_LABELS, formatTimeUntil, nextRebalance } from '@/lib/backtest/timer';
import { useAnalytics } from '@/lib/backtest/worker/use-analytics';
import type { PortfolioSummaryOk } from '@/lib/engine/types';
import EChart from '../charts/EChart';
import styles from './Report.module.css';

const MAX_SERIES = 12;
const TOP_N = 10;

function pct(v: number | null | undefined, d = 2) {
  return v === null || v === undefined || !Number.isFinite(v) ? 'N/A' : `${v.toFixed(d)}%`;
}

function ValueDrawdownCharts({ result, portfolios }: { result: LoadedResult; portfolios: PortfolioSummaryOk[] }) {
  const charts = useAnalytics<ChartsResult>(result, { op: 'charts', mode: 'with_additions', benchmarks: [], maxPoints: 900 });
  const shown = useMemo(() => new Set(portfolios.slice(0, MAX_SERIES).map((p) => `pf:${p.index}`)), [portfolios]);
  const options = useMemo(() => {
    const c = charts.data?.charts;
    if (!c) return null;
    const defs = c.defs.filter((d) => shown.has(d.id));
    const dates = c.valueData.map((r) => r.date);
    const base = {
      animation: false,
      grid: { left: 70, right: 16, top: 36, bottom: 30 },
      legend: { top: 0, type: 'plain', textStyle: { fontSize: 9 } },
      xAxis: { type: 'category', data: dates, boundaryGap: false, axisLabel: { formatter: (d: string) => d.slice(0, 4) } },
    };
    const value = {
      ...base,
      yAxis: { type: 'log', axisLabel: { formatter: (v: number) => `$${v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : v}` } },
      series: defs.map((d) => ({
        name: d.label, type: 'line', showSymbol: false, lineStyle: { width: 1.2, color: d.color }, itemStyle: { color: d.color },
        data: c.valueData.map((r) => (typeof r[d.id] === 'number' ? r[d.id] : null)),
      })),
    };
    const dd = {
      ...base,
      yAxis: { type: 'value', max: 0, axisLabel: { formatter: '{value}%' } },
      series: defs.map((d) => {
        let peak = -Infinity;
        return {
          name: d.label, type: 'line', showSymbol: false, lineStyle: { width: 1, color: d.color }, itemStyle: { color: d.color },
          data: c.valueData.map((r) => {
            const v = r[d.id];
            if (typeof v !== 'number') return null;
            if (v > peak) peak = v;
            return peak > 0 ? (v / peak - 1) * 100 : null;
          }),
        };
      }),
    };
    return { value, dd };
  }, [charts.data, shown]);
  if (!options) return <p className={styles.muted}>Préparation des graphiques…</p>;
  return (
    <>
      <h3>Valeur du portefeuille (échelle log, avec ajouts)</h3>
      <EChart option={options.value} height={320} theme="bt-light" />
      <h3>Drawdown</h3>
      <EChart option={options.dd} height={240} theme="bt-light" />
      {portfolios.length > MAX_SERIES && <p className={styles.muted}>{MAX_SERIES} premiers portfolios affichés sur {portfolios.length}.</p>}
    </>
  );
}

function YearlyTable({ result, portfolios }: { result: LoadedResult; portfolios: PortfolioSummaryOk[] }) {
  const { data } = useAnalytics<PeriodsResult>(result, { op: 'periods', kind: 'year' });
  if (!data) return null;
  const cols = data.table.columns.filter((c) => portfolios.slice(0, MAX_SERIES).some((p) => p.index === c.index));
  return (
    <table className={styles.table}>
      <thead>
        <tr><th>Année</th>{cols.map((c) => <th key={c.index}>{c.name}</th>)}</tr>
      </thead>
      <tbody>
        {data.table.labels.map((y, k) => (
          <tr key={y}>
            <td>{y}</td>
            {cols.map((c) => {
              const v = c.pct[k];
              return <td key={c.index} className={v > 0 ? styles.pos : v < 0 ? styles.neg : ''}>{pct(Number.isNaN(v) ? null : v)}</td>;
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConfigSection({ p }: { p: PortfolioSummaryOk }) {
  const c = p.config;
  const rows: [string, string][] = [
    ['Investissement initial', fmtMoney(c.initial_value)],
    ['Ajouts', `${fmtMoney(c.added_amount)} (${c.added_frequency})`],
    ['Rebalancement', String(c.rebalancing_frequency)],
    ['Benchmark', String(c.benchmark_ticker)],
    ['Momentum', c.use_momentum ? `${c.momentum_strategy ?? ''} · négatif : ${c.negative_momentum_strategy ?? ''}` : 'Non'],
    ['Fenêtres', (c.momentum_windows ?? []).map((w) => `${w.lookback}/${w.exclude}×${w.weight}`).join(' · ') || '—'],
    ['Score plafonné par fenêtre', c.use_window_capped_score ? 'Oui (−100 % à +100 %)' : 'Non'],
    ['Bêta / volatilité', `${c.calc_beta ? `bêta ${c.beta_window_days}-${c.exclude_days_beta}` : 'bêta non'} · ${c.calc_volatility ? `vol ${c.vol_window_days}-${c.exclude_days_vol}` : 'vol non'}`],
    ['Filtre MA', c.use_sma_filter ? `${c.ma_type ?? 'SMA'} ${c.sma_window ?? 200}` : 'Non'],
    ['Croisement MA', c.ma_cross_rebalance ? `tolérance ${c.ma_tolerance_percent ?? 2}% · ${c.ma_confirmation_days ?? 3} j` : 'Non'],
  ];
  return (
    <div className={styles.block}>
      <h3><span className={styles.swatch} style={{ background: portfolioColor(p.index) }} />{p.name}</h3>
      <div className={styles.twoCol}>
        <table className={styles.kv}><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
        <table className={styles.table}>
          <thead><tr><th>Ticker</th><th>Allocation initiale</th><th>Dividendes</th></tr></thead>
          <tbody>
            {c.stocks.map((s) => (
              <tr key={s.ticker}><td>{s.ticker}</td><td>{c.use_momentum ? 'Dynamique' : pct(s.allocation * 100)}</td><td>{s.include_dividends ? 'Oui' : 'Non'}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatsTableReport({ rows }: { rows: PortfolioSummaryOk[] }) {
  return (
    <table className={styles.table}>
      <thead>
        <tr><th>Portfolio</th>{STAT_COLUMNS.map((c) => <th key={c.key}>{c.label}</th>)}<th>Valeur finale</th></tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.index}>
            <td><span className={styles.swatch} style={{ background: portfolioColor(p.index) }} />{p.name}</td>
            {STAT_COLUMNS.map((c) => <td key={c.key}>{p.stats_display[c.key] ?? 'N/A'}</td>)}
            <td>{fmtMoney(p.stats['Final Value (with)'])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AllocationSection({ p }: { p: PortfolioSummaryOk }) {
  const t = p.today;
  const next = p.timer ? nextRebalance(p.timer.frequency, p.timer.last_rebalance) : null;
  const pie = t?.pie ?? [];
  const option = useMemo(() => ({
    animation: false,
    series: [{
      type: 'pie', radius: ['35%', '68%'],
      label: { fontSize: 9, formatter: (x: { name: string; value: number }) => `${x.name} ${x.value.toFixed(1)}%` },
      data: pie.map(([name, value]) => ({ name, value })),
    }],
  }), [pie]);
  return (
    <div className={styles.block}>
      <h3><span className={styles.swatch} style={{ background: portfolioColor(p.index) }} />{p.name}</h3>
      {p.timer && (
        <p className={styles.muted}>
          {FREQUENCY_LABELS[p.timer.frequency] ?? p.timer.frequency} · dernier rebalancement {p.timer.last_rebalance}
          {next ? ` · prochain ${next.date.toLocaleDateString('fr-CA')} (dans ${formatTimeUntil(next.msUntil)})` : ''}
        </p>
      )}
      <div className={styles.twoCol}>
        {pie.length > 0 ? <EChart option={option} height={220} theme="bt-light" /> : <p className={styles.muted}>Aucune allocation.</p>}
        {t?.table && (
          <table className={styles.table}>
            <thead><tr><th>Ticker</th><th>Allocation</th><th>Prix</th><th>Actions</th><th>Valeur</th></tr></thead>
            <tbody>
              {t.table.rows.map((r) => (
                <tr key={r.ticker}>
                  <td>{r.ticker}</td><td>{pct(r.alloc_pct)}</td><td>{r.price === null ? '' : fmtMoney(r.price)}</td>
                  <td>{r.ticker === 'CASH' ? '' : r.shares.toFixed(1)}</td><td>{fmtMoney(r.value)}</td>
                </tr>
              ))}
              <tr className={styles.total}><td>TOTAL</td><td>{pct(t.table.total.alloc_pct)}</td><td /><td /><td>{fmtMoney(t.table.total.value)}</td></tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function ReportView({ runId }: { runId: string }) {
  const [state, setState] = useState<{ row: BacktestRunRow; result: LoadedResult | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  useEffect(() => {
    loadRun(runId).then(setState, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [runId]);

  const defaultFileName = state
    ? `${state.row.label || 'Rapport de backtest'} ${new Date().toISOString().slice(0, 10)}`
    : 'Rapport de backtest';

  /** Browsers name the "Save as PDF" file after document.title. */
  const printReport = () => {
    const previous = document.title;
    document.title = (fileName.trim() || defaultFileName).replace(/[\\/:*?"<>|]+/g, '-');
    const restore = () => {
      document.title = previous;
      window.removeEventListener('afterprint', restore);
    };
    window.addEventListener('afterprint', restore);
    window.print();
  };

  const pfs = useMemo(() => (state?.result ? okSummaries(state.result.summary) : []), [state]);
  const byFinal = useMemo(
    () => [...pfs].sort((a, b) => (b.stats['Final Value (with)'] ?? -Infinity) - (a.stats['Final Value (with)'] ?? -Infinity)),
    [pfs],
  );

  if (error) return <div className={styles.page}><p>{error}</p></div>;
  if (!state) return <div className={styles.page}><p className={styles.muted}>Chargement du rapport…</p></div>;
  if (!state.result) return <div className={styles.page}><p>Le résultat de ce run n’est plus disponible.</p></div>;
  const { row, result } = state;
  const sim = result.summary.simulation;

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <input
          className={styles.fileName}
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          placeholder={defaultFileName}
          aria-label="Nom du fichier PDF"
          title="Nom proposé lors de « Enregistrer en PDF »"
        />
        <button type="button" className={styles.printBtn} onClick={printReport}>Imprimer / Enregistrer en PDF</button>
      </div>
      <header className={styles.cover}>
        <h1>{row.label || 'Rapport de backtest'}</h1>
        <p>
          {sim.display_start ?? sim.start} → {sim.end} · {pfs.length} portfolio{pfs.length > 1 ? 's' : ''} · moteur v{result.summary.engine_version}
        </p>
        <p className={styles.muted}>Généré le {new Date().toLocaleString('fr-CA')}</p>
      </header>

      <section>
        <h2>1. Configurations et paramètres</h2>
        {pfs.map((p) => <ConfigSection key={p.index} p={p} />)}
      </section>

      <section className={styles.breakBefore}>
        <h2>2. Valeur et drawdown</h2>
        <ValueDrawdownCharts result={result} portfolios={pfs} />
      </section>

      <section className={styles.breakBefore}>
        <h2>3. Statistiques finales</h2>
        <StatsTableReport rows={pfs} />
        {pfs.length > TOP_N && (
          <>
            <h3>3.1 Les {TOP_N} meilleurs portfolios par valeur finale</h3>
            <StatsTableReport rows={byFinal.slice(0, TOP_N)} />
            <h3>3.2 Les {TOP_N} moins bons portfolios par valeur finale</h3>
            <StatsTableReport rows={byFinal.slice(-TOP_N).reverse()} />
          </>
        )}
        <h3>Rendements annuels</h3>
        <YearlyTable result={result} portfolios={pfs} />
      </section>

      <section className={styles.breakBefore}>
        <h2>4. Allocations et rebalancement</h2>
        {pfs.map((p) => <AllocationSection key={p.index} p={p} />)}
      </section>
    </div>
  );
}
