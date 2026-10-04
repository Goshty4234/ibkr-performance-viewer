'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useBacktestStore } from '@/lib/backtest/store';
import { toEngineConfig } from '@/lib/backtest/portfolio';
import { EngineClient, engineOutdated } from '@/lib/engine/client';
import {
  histogram, mcCancel, mcJob, mcResult, mcSubmit, MC_DEFAULTS, pairOf, parseTickers,
  type McJob, type McOptions, type McResult, type McStatKey, type McUniverseSource,
} from '@/lib/engine/montecarlo';
import { useEngineStore } from '@/lib/engine/store';
import EChart from '../charts/EChart';
import styles from './MonteCarlo.module.css';

const COLORS = ['#4d8dff', '#ffb020', '#4ade80', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#94a3b8', '#64748b'];
const BASELINE_COLOR = '#94a3b8';
const MAX_DRAWN_CURVES = 250;

const UNIVERSES: { id: McUniverseSource; label: string; tip: string }[] = [
  { id: 'sp500', label: 'S&P 500 (composition actuelle)', tip: 'Les ~500 compagnies actuelles du S&P 500 (liste Wikipédia).' },
  { id: 'us', label: 'Toutes les actions américaines', tip: 'Actions ordinaires cotées aux États-Unis (milliers de tickers : le premier chargement des prix est long).' },
  { id: 'portfolios', label: 'Tickers des portfolios choisis', tip: 'Les tickers déjà listés dans les portfolios cochés (réunis).' },
  { id: 'list', label: 'Ma liste de tickers', tip: 'Colle ta propre liste (espaces, virgules ou retours à la ligne).' },
];

const METRICS: { id: McStatKey; label: string; kind: 'pct' | 'num' | 'frac'; higherIsBetter: boolean }[] = [
  { id: 'CAGR', label: 'CAGR', kind: 'pct', higherIsBetter: true },
  { id: 'MaxDrawdown', label: 'Drawdown max', kind: 'pct', higherIsBetter: true },
  { id: 'Sharpe', label: 'Sharpe', kind: 'num', higherIsBetter: true },
  { id: 'Sortino', label: 'Sortino', kind: 'num', higherIsBetter: true },
  { id: 'Volatility', label: 'Volatilité', kind: 'pct', higherIsBetter: false },
  { id: 'Total Return', label: 'Rendement total', kind: 'pct', higherIsBetter: true },
  { id: 'MWRR', label: 'MWRR', kind: 'pct', higherIsBetter: true },
  { id: 'UlcerIndex', label: 'Ulcer index', kind: 'num', higherIsBetter: false },
  { id: 'holdings', label: 'Positions moyennes', kind: 'num', higherIsBetter: true },
  { id: 'cash', label: 'Part en cash', kind: 'frac', higherIsBetter: false },
];

const nf = (v: number, d: number) => v.toLocaleString('fr-CA', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf(v, d)} %`);
const share = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${nf(v * 100, 0)} %`);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : nf(v, d));
const pts = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${nf(v, d)} pt`);
function fmtMetric(kind: 'pct' | 'num' | 'frac', v: number | null | undefined): string {
  if (kind === 'pct') return pct(v);
  if (kind === 'frac') return v === null || v === undefined ? '—' : pct(v * 100, 0);
  return num(v);
}

function useClient(): { client: EngineClient | null; outdated: boolean; detecting: boolean } {
  const engine = useEngineStore((s) => s.engine);
  const status = useEngineStore((s) => s.status);
  const client = useMemo(() => (engine ? new EngineClient(engine.url, engine.health.auth_required) : null), [engine]);
  return { client, outdated: engineOutdated(engine?.health), detecting: status === 'detecting' };
}

export default function MonteCarloView() {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const runOptions = useBacktestStore((s) => s.options);
  const { client, outdated, detecting } = useClient();
  const [opt, setOpt] = useState<McOptions>(MC_DEFAULTS);
  const [listText, setListText] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<McJob | null>(null);
  const [result, setResult] = useState<McResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set([...prev].filter((id) => portfolios.some((p) => p._id === id))) : new Set(portfolios.map((p) => p._id))));
  }, [portfolios]);

  const running = job !== null && (job.status === 'queued' || job.status === 'running');
  const chosen = portfolios.filter((p) => selected.has(p._id));
  const set = <K extends keyof McOptions>(k: K, v: McOptions[K]) => setOpt((o) => ({ ...o, [k]: v }));
  const listTickers = useMemo(() => parseTickers(listText), [listText]);
  const portfolioTickers = useMemo(
    () => [...new Set(chosen.flatMap((p) => p.stocks.map((s) => s.ticker.trim().toUpperCase()).filter((t) => t && t !== 'CASH')))],
    [chosen],
  );
  const universeCount = opt.universe.source === 'list' ? listTickers.length : opt.universe.source === 'portfolios' ? portfolioTickers.length : null;
  const tooSmall = universeCount !== null && universeCount < opt.n_pick;
  const runsPerDraw = chosen.length + (opt.baseline ? 1 : 0);

  const run = useCallback(async () => {
    if (!client || !chosen.length) return;
    setError(null);
    setResult(null);
    const mc: McOptions = {
      ...opt,
      universe: { source: opt.universe.source, tickers: opt.universe.source === 'list' ? listTickers : [] },
    };
    const options = {
      first_rebalance_strategy: runOptions.first_rebalance_strategy,
      auto_adjust_momentum_start: runOptions.auto_adjust_momentum_start,
      price_update: 'topup' as const,
    };
    try {
      let j = await mcSubmit(client, chosen.map(toEngineConfig), options, mc);
      setJob(j);
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        try {
          j = await mcJob(client, j.id);
          setJob(j);
          if (j.status === 'done') {
            clearInterval(timer.current!);
            setResult(await mcResult(client, j.id));
          } else if (j.status === 'error' || j.status === 'cancelled') {
            clearInterval(timer.current!);
            if (j.error) setError(j.error);
          }
        } catch (e) {
          clearInterval(timer.current!);
          setError(e instanceof Error ? e.message : String(e));
        }
      }, 800);
    } catch (e) {
      setJob(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, chosen, opt, listTickers, runOptions.first_rebalance_strategy, runOptions.auto_adjust_momentum_start]);

  const cancel = () => {
    if (client && job) mcCancel(client, job.id).catch(() => {});
  };

  return (
    <div className={styles.wrap}>
      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Monte Carlo sur de vraies actions</div>
            <div className={styles.sub}>
              Chaque tirage prend {opt.n_pick} actions au hasard dans l’univers et fait rouler tous les portfolios cochés sur exactement ces
              actions, comme un run normal (mêmes réglages que dans Construire : momentum, filtres, entrée dans le S&P 500, market cap
              minimum…). Le tirage suivant en prend d’autres. Comme les portfolios partagent les mêmes actions à chaque tirage, on voit
              si une option fait vraiment la différence ou si elle a juste eu de la chance une fois.
            </div>
          </div>
        </div>

        <div className={styles.pick}>
          <span className={styles.pickLabel}>Portfolios comparés :</span>
          {portfolios.map((p) => (
            <label key={p._id} className={styles.chip}>
              <input type="checkbox" checked={selected.has(p._id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(p._id); else n.delete(p._id); return n; })} />
              {p.name}
            </label>
          ))}
          {!portfolios.length && <span className={styles.hint}>Aucun portfolio : crée-en dans l’onglet Construire.</span>}
        </div>

        <div className={styles.grid}>
          <label className={styles.field} title={UNIVERSES.find((u) => u.id === opt.universe.source)?.tip}>Univers
            <select value={opt.universe.source} onChange={(e) => set('universe', { source: e.target.value as McUniverseSource, tickers: [] })}>
              {UNIVERSES.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
            </select>
          </label>
          <label className={styles.field} title="Nombre d’actions dans chaque tirage : c’est l’univers des portfolios pour ce tirage.">Actions par tirage
            <input type="number" min={1} max={500} value={opt.n_pick} onChange={(e) => set('n_pick', Math.min(500, Math.max(1, Math.trunc(Number(e.target.value) || 1))))} />
          </label>
          <label className={styles.field} title="Nombre de tirages (de runs) : plus il y en a, plus la comparaison est fiable.">Nombre de tirages
            <input type="number" min={1} max={2000} value={opt.n_draws} onChange={(e) => set('n_draws', Math.min(2000, Math.max(1, Math.trunc(Number(e.target.value) || 1))))} />
          </label>
          <label className={styles.field} title="Vide = dès que des prix existent. Les actions entrent dans le portfolio quand leur historique commence.">Début
            <input type="date" value={opt.start_date ?? ''} onChange={(e) => set('start_date', e.target.value || null)} />
          </label>
          <label className={styles.field} title="Vide = jusqu’au dernier prix disponible.">Fin
            <input type="date" value={opt.end_date ?? ''} onChange={(e) => set('end_date', e.target.value || null)} />
          </label>
          <label className={styles.field} title="Même graine = mêmes tirages : relancer avec d’autres réglages compare sur exactement les mêmes actions.">Graine des tirages
            <span className={styles.inline}>
              <input type="number" value={opt.seed} onChange={(e) => set('seed', Math.trunc(Number(e.target.value) || 0))} />
              <button type="button" className="btn btn-ghost btn-sm" title="Nouvelle graine (autres tirages)" onClick={() => set('seed', Math.floor(Math.random() * 1e9))}>🎲</button>
            </span>
          </label>
          <label className={styles.check} title="Ajoute à chaque tirage un portfolio équipondéré des mêmes actions, rebalancé chaque mois : la référence « sans stratégie ».">
            <input type="checkbox" checked={opt.baseline} onChange={(e) => set('baseline', e.target.checked)} />
            Référence équipondérée des actions tirées
          </label>
        </div>

        {opt.universe.source === 'list' && (
          <label className={styles.field}>Tickers de l’univers ({listTickers.length})
            <textarea className={styles.textarea} rows={4} value={listText} placeholder="AAPL MSFT NVDA AMZN …" onChange={(e) => setListText(e.target.value)} />
          </label>
        )}
        {opt.universe.source === 'portfolios' && (
          <div className={styles.hint}>{portfolioTickers.length} tickers dans les portfolios cochés.</div>
        )}
        <div className={styles.hint}>
          {opt.n_draws.toLocaleString('fr-CA')} tirages × {runsPerDraw} portfolio{runsPerDraw > 1 ? 's' : ''} = {(opt.n_draws * runsPerDraw).toLocaleString('fr-CA')} backtests,
          répartis sur tous les cœurs du moteur. Options de Construire reprises : premier rebalancement « {runOptions.first_rebalance_strategy === 'rebalancing_date' ? 'date de rebalancement' : 'fenêtre momentum complète'} »
          {runOptions.auto_adjust_momentum_start ? ', démarrage avancé pour le momentum' : ''} ; les actions entrent quand leur historique commence.
        </div>

        <div className={styles.actions}>
          {!running ? (
            <button type="button" className="btn btn-primary" disabled={!client || outdated || !chosen.length || tooSmall} onClick={run}
              title={!client ? 'Aucun moteur détecté' : outdated ? 'Mets le moteur à jour' : tooSmall ? 'Univers plus petit que le nombre d’actions par tirage' : undefined}>
              Lancer {opt.n_draws.toLocaleString('fr-CA')} tirages
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={cancel}>Annuler</button>
          )}
          {tooSmall && <span className={styles.warn}>L’univers compte {universeCount} tickers : moins que {opt.n_pick} actions par tirage.</span>}
          {!client && detecting && <span className={styles.warn}>Connexion au moteur… patiente.</span>}
          {!client && !detecting && <span className={styles.warn}>Moteur de calcul non détecté.</span>}
          {outdated && <span className={styles.warn}>Le moteur doit être mis à jour pour ce Monte Carlo.</span>}
          {job && running && (
            <span className={styles.progress}>
              <span className={styles.bar}><span style={{ width: `${Math.round(job.progress * 100)}%` }} /></span>
              {job.message}
            </span>
          )}
        </div>
        {error && <div className={styles.error}>{error}</div>}
      </section>

      {result && <McResults result={result} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------

function seriesColor(result: McResult, i: number): string {
  if (result.series[i]?.kind === 'baseline') return BASELINE_COLOR;
  const k = result.series.slice(0, i).filter((s) => s.kind !== 'baseline').length;
  return COLORS[k % COLORS.length];
}

function McResults({ result }: { result: McResult }) {
  const [metricId, setMetricId] = useState<McStatKey>('CAGR');
  const [log, setLog] = useState(true);
  const [highlight, setHighlight] = useState<number | null>(null);
  const series = result.series;
  const color = (i: number) => seriesColor(result, i);
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];
  const ports = series.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'portfolio');
  const baseIdx = series.findIndex((s) => s.kind === 'baseline');
  const nDraws = result.draws.length;
  const shownDraws = Math.min(nDraws, MAX_DRAWN_CURVES);

  const curvesOption = useMemo(() => {
    const clean = (v: number | null) => (v === null ? null : log && v <= 0 ? null : v);
    const out: Record<string, unknown>[] = [];
    series.forEach((s, i) => {
      for (let d = 0; d < shownDraws; d += 1) {
        const hot = highlight === d;
        out.push({
          id: `c-${i}-${d}`, name: s.name, type: 'line', data: s.curves[d].map(clean), showSymbol: false, silent: !hot,
          lineStyle: { width: hot ? 2.2 : 0.7, color: color(i), opacity: highlight === null ? 0.22 : hot ? 1 : 0.07 },
          itemStyle: { color: color(i) }, z: hot ? 5 : 1, emphasis: { disabled: true }, animation: false,
        });
      }
      out.push({
        id: `m-${i}`, name: s.name, type: 'line', data: s.fan.p50.map(clean), showSymbol: false,
        lineStyle: { width: 2.6, color: color(i), type: s.kind === 'baseline' ? 'dashed' : 'solid' }, itemStyle: { color: color(i) }, z: 4,
      });
    });
    if (result.benchmark) {
      out.push({
        id: 'bench', name: `${result.benchmark.ticker} réel (prix)`, type: 'line', data: result.benchmark.curve.map(clean), showSymbol: false,
        lineStyle: { width: 1.8, color: '#f4f7fb', type: 'dotted' }, itemStyle: { color: '#f4f7fb' }, z: 3,
      });
    }
    return {
      animation: false,
      grid: { left: 58, right: 18, top: 40, bottom: 56 },
      legend: { top: 0, type: 'scroll' },
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 8 }],
      tooltip: {
        trigger: 'axis',
        formatter: (params: { seriesId: string; seriesName: string; value: number | null; color: string; axisValue: string }[]) => {
          const rows = params.filter((p) => p.value !== null && (p.seriesId.startsWith('m-') || p.seriesId === 'bench' || (highlight !== null && p.seriesId.endsWith(`-${highlight}`) && p.seriesId.startsWith('c-'))));
          const head = `<div style="margin-bottom:4px">${params[0]?.axisValue ?? ''}</div>`;
          return head + rows.map((p) => `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}${p.seriesId.startsWith('m-') ? ' (médiane)' : p.seriesId.startsWith('c-') ? ` (tirage ${highlight! + 1})` : ''} : ×${num(p.value, 2)}</div>`).join('');
        },
      },
      xAxis: { type: 'category', data: result.dates, axisLabel: { formatter: (v: string) => v.slice(0, 4) } },
      yAxis: log
        ? { type: 'log', min: 'dataMin', axisLabel: { formatter: (v: number) => `×${v}` } }
        : { type: 'value', axisLabel: { formatter: (v: number) => `×${v}` } },
      series: out,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, log, highlight, shownDraws]);

  const histOption = useMemo(() => {
    const h = histogram(series.map((s) => s.stats[metricId]), 30);
    const fmtAxis = (v: number) => (metric.kind === 'pct' ? `${v.toFixed(0)} %` : metric.kind === 'frac' ? `${(v * 100).toFixed(0)} %` : v.toFixed(2));
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 36, bottom: 30 },
      legend: { top: 0, type: 'scroll' },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${Number(v).toFixed(1)} % des tirages` },
      xAxis: { type: 'category', data: h.centers.map(fmtAxis) },
      yAxis: { type: 'value', axisLabel: { formatter: '{value} %' } },
      series: series.map((s, i) => ({
        name: s.name, type: 'line', smooth: true, showSymbol: false, data: h.shares[i],
        lineStyle: { width: s.kind === 'baseline' ? 1.5 : 2.2, type: s.kind === 'baseline' ? 'dashed' : 'solid', color: color(i) },
        itemStyle: { color: color(i) }, areaStyle: s.kind === 'baseline' ? undefined : { opacity: 0.06, color: color(i) },
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, metricId]);

  const verdicts: string[] = [];
  for (let x = 0; x < ports.length; x += 1) {
    for (let y = x + 1; y < ports.length; y += 1) {
      const p = pairOf(result, ports[x].i, ports[y].i);
      if (p) verdicts.push(pairSentence(ports[x].s.name, ports[y].s.name, p.cagr_win, p.cagr_diff.p50, p.cagr_diff.p5, p.cagr_diff.p95, p.sharpe_win, p.drawdown_win, p.n));
    }
  }
  if (baseIdx >= 0) {
    for (const { s, i } of ports) {
      const p = pairOf(result, i, baseIdx);
      if (p) verdicts.push(pairSentence(s.name, 'la référence équipondérée', p.cagr_win, p.cagr_diff.p50, p.cagr_diff.p5, p.cagr_diff.p95, p.sharpe_win, p.drawdown_win, p.n));
    }
  }

  const u = result.universe;
  const excluded = u.n_missing + u.n_stale + u.n_short;

  return (
    <>
      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Verdict</div>
            <div className={styles.sub}>
              {nDraws.toLocaleString('fr-CA')} tirages de {result.options.n_pick} actions parmi {u.count.toLocaleString('fr-CA')} ({u.label}), du {result.window.start} au {result.window.end}.
              Calculé en {nf(result.elapsed_s, 1)} s sur {result.options.workers} processus ({nf(result.busy_s, 0)} s de calcul en tout).
            </div>
          </div>
        </div>
        <ul className={styles.concl}>
          {verdicts.map((v, k) => <li key={k}>{v}</li>)}
          {!verdicts.length && <li>Un seul portfolio sans référence : regarde la distribution ci-dessous.</li>}
        </ul>
        {excluded > 0 && (
          <details className={styles.details}>
            <summary>{excluded} tickers de l’univers laissés de côté</summary>
            {u.n_missing > 0 && <div className={styles.warnBlock}><strong>Sans prix ({u.n_missing}) :</strong> {u.missing.join(', ')}{u.n_missing > u.missing.length ? '…' : ''}</div>}
            {u.n_stale > 0 && <div className={styles.warnBlock}><strong>Plus cotés ou prix arrêtés ({u.n_stale}) :</strong> {u.stale.join(', ')}{u.n_stale > u.stale.length ? '…' : ''}</div>}
            {u.n_short > 0 && <div className={styles.warnBlock}><strong>Moins d’un an d’historique sur la période ({u.n_short}) :</strong> {u.short.join(', ')}{u.n_short > u.short.length ? '…' : ''}</div>}
          </details>
        )}
        {(result.errors.length > 0 || result.warnings.length > 0) && (
          <details className={styles.details}>
            <summary>Avertissements ({result.errors.length + result.warnings.length})</summary>
            <ul>
              {result.warnings.map((w, k) => <li key={`w${k}`}>{w}</li>)}
              {result.errors.map((e, k) => <li key={`e${k}`}>Tirage {e.draw + 1}{e.portfolio ? ` · ${e.portfolio}` : ''} : {e.error}</li>)}
            </ul>
          </details>
        )}
      </section>

      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Toutes les courbes (valeur sans ajouts, départ = 1)</div>
            <div className={styles.sub}>
              Une ligne fine par tirage et par portfolio, la médiane en gras{result.benchmark ? `, ${result.benchmark.ticker} réel en pointillé` : ''}.
              {nDraws > shownDraws ? ` Les ${shownDraws} premiers tirages sont tracés (les statistiques couvrent les ${nDraws}).` : ''} Clique un tirage dans le tableau du bas pour le surligner.
            </div>
          </div>
          <div className={styles.inline}>
            <label className={styles.check}><input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />Échelle log</label>
            {highlight !== null && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHighlight(null)}>Tirage {highlight + 1} ✕</button>}
          </div>
        </div>
        <EChart option={curvesOption} height={460} />
      </section>

      {series.length > 1 && (
        <section className={`card ${styles.card}`}>
          <div className={styles.title}>Face à face (mêmes actions, même période)</div>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Portfolio A</th><th>Portfolio B</th>
                  <th title="Part des tirages où A a un meilleur CAGR que B">A meilleur CAGR</th>
                  <th title="CAGR de A moins CAGR de B, médiane des tirages">Écart médian</th>
                  <th title="90 % des tirages ont un écart dans cet intervalle">Écart 5 % – 95 %</th>
                  <th>A meilleur Sharpe</th>
                  <th>A drawdown plus petit</th>
                </tr>
              </thead>
              <tbody>
                {result.pairs.filter((p) => p.a < p.b).map((p) => (
                  <tr key={`${p.a}-${p.b}`}>
                    <td><span className={styles.dot} style={{ background: color(p.a) }} />{series[p.a].name}</td>
                    <td><span className={styles.dot} style={{ background: color(p.b) }} />{series[p.b].name}</td>
                    <td className={styles.n} style={winStyle(p.cagr_win)}>{share(p.cagr_win)}</td>
                    <td className={styles.n}>{pts(p.cagr_diff.p50, 2)}</td>
                    <td className={styles.n}>{pts(p.cagr_diff.p5)} à {pts(p.cagr_diff.p95)}</td>
                    <td className={styles.n} style={winStyle(p.sharpe_win)}>{share(p.sharpe_win)}</td>
                    <td className={styles.n} style={winStyle(p.drawdown_win)}>{share(p.drawdown_win)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.hint}>Chaque tirage compare les portfolios sur exactement les mêmes actions : un pourcentage loin de 50 % montre une vraie différence, proche de 50 % une différence due au hasard des actions.</div>
        </section>
      )}

      <section className={`card ${styles.card}`}>
        <div className={styles.title}>Résumé par portfolio</div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Portfolio</th>
                <th>CAGR médian</th><th>CAGR 5 %</th><th>CAGR 95 %</th>
                <th>DD max médian</th><th>DD max 5 % pire</th>
                <th>Sharpe médian</th><th>Volatilité médiane</th>
                <th>Positions moy.</th><th>Cash moy.</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s, i) => (
                <tr key={s.name} className={s.kind === 'baseline' ? styles.base : undefined}>
                  <td><span className={styles.dot} style={{ background: color(i) }} />{s.name}</td>
                  <td className={styles.n}>{pct(s.summary.CAGR.p50)}</td>
                  <td className={styles.n}>{pct(s.summary.CAGR.p5)}</td>
                  <td className={styles.n}>{pct(s.summary.CAGR.p95)}</td>
                  <td className={styles.n}>{pct(s.summary.MaxDrawdown.p50)}</td>
                  <td className={styles.n}>{pct(s.summary.MaxDrawdown.p5)}</td>
                  <td className={styles.n}>{num(s.summary.Sharpe.p50)}</td>
                  <td className={styles.n}>{pct(s.summary.Volatility.p50)}</td>
                  <td className={styles.n}>{num(s.summary.holdings.mean, 1)}</td>
                  <td className={styles.n}>{s.summary.cash.mean === null ? '—' : pct(s.summary.cash.mean * 100, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div className={styles.title}>Distribution sur les tirages</div>
          <select className={styles.select} value={metricId} onChange={(e) => setMetricId(e.target.value as McStatKey)}>
            {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <EChart option={histOption} height={300} />
      </section>

      <DrawsTable result={result} highlight={highlight} onPick={setHighlight} color={color} />
    </>
  );
}

function DrawsTable({ result, highlight, onPick, color }: { result: McResult; highlight: number | null; onPick: (d: number | null) => void; color: (i: number) => string }) {
  const [sortBy, setSortBy] = useState<number | null>(null);
  const series = result.series;
  const rows = useMemo(() => {
    const idx = result.draws.map((_, d) => d);
    if (sortBy === null) return idx;
    const v = (d: number) => series[sortBy].stats.CAGR[d] ?? -Infinity;
    return idx.sort((a, b) => v(b) - v(a));
  }, [result, series, sortBy]);
  const best = (d: number) => {
    let k = -1;
    let bestV = -Infinity;
    series.forEach((s, i) => {
      const v = s.stats.CAGR[d];
      if (v !== null && v > bestV) { bestV = v; k = i; }
    });
    return k;
  };
  return (
    <section className={`card ${styles.card}`}>
      <div className={styles.title}>Les tirages</div>
      <div className={styles.sub}>CAGR et drawdown max de chaque portfolio pour chaque tirage ; le meilleur CAGR du tirage est en couleur. Clique une ligne pour la voir sur le graphique, un en-tête pour trier.</div>
      <div className={`${styles.scroll} ${styles.tall}`}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>#</th><th>Période</th><th>Actions tirées</th>
              {series.map((s, i) => (
                <th key={s.name} className={styles.clickable} onClick={() => setSortBy(sortBy === i ? null : i)} title="Trier par ce CAGR">
                  <span className={styles.dot} style={{ background: color(i) }} />{shortName(s.name)} {sortBy === i ? '▼' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const draw = result.draws[d];
              const b = best(d);
              return (
                <tr key={d} className={`${styles.clickable} ${highlight === d ? styles.hot : ''}`} onClick={() => onPick(highlight === d ? null : d)}>
                  <td className={styles.n}>{d + 1}</td>
                  <td className={styles.n}>{draw.start?.slice(0, 7) ?? '—'} → {draw.end?.slice(0, 7) ?? '—'}</td>
                  <td className={styles.tickers} title={draw.tickers.join(' ')}>{draw.error ? `Erreur : ${draw.error}` : draw.tickers.join(' ')}</td>
                  {series.map((s, i) => (
                    <td key={s.name} className={styles.n} style={i === b ? { color: color(i), fontWeight: 700 } : undefined}>
                      {pct(s.stats.CAGR[d])} <span className={styles.faint}>{pct(s.stats.MaxDrawdown[d], 0)}</span>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function winStyle(v: number | null): CSSProperties | undefined {
  if (v === null) return undefined;
  const strength = Math.min(1, Math.abs(v - 0.5) * 2);
  const c = v >= 0.5 ? '45,212,168' : '255,107,122';
  return { background: `rgba(${c},${0.08 + 0.3 * strength})` };
}

function shortName(n: string): string {
  return n.replace('Équipondéré des actions tirées (mensuel)', 'Équipondéré');
}

function pairSentence(a: string, b: string, win: number | null, med: number | null, p5: number | null, p95: number | null,
  sharpeWin: number | null, ddWin: number | null, n: number): string {
  if (win === null || !n) return `${a} contre ${b} : pas assez de tirages comparables.`;
  const verdict =
    win >= 0.7 ? 'bat nettement' : win >= 0.58 ? 'bat' : win > 0.42 ? 'fait jeu égal avec' : win > 0.3 ? 'fait moins bien que' : 'fait nettement moins bien que';
  return `${a} ${verdict} ${b} : meilleur CAGR dans ${share(win)} des ${n} tirages (écart médian ${pts(med, 2)}/an, 90 % des tirages entre ${pts(p5)} et ${pts(p95)}). `
    + `Meilleur Sharpe dans ${share(sharpeWin)} des tirages, drawdown plus petit dans ${share(ddWin)}.`;
}

