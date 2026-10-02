'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBacktestStore } from '@/lib/backtest/store';
import { toEngineConfig } from '@/lib/backtest/portfolio';
import { EngineClient, engineOutdated } from '@/lib/engine/client';
import {
  histogram, mcCancel, mcJob, mcRealUniverse, mcResult, mcSubmit, MC_DEFAULTS,
  type McJob, type McMetric, type McOptions, type McResult, type McSeries, type McSynthetic,
} from '@/lib/engine/montecarlo';
import { useEngineStore } from '@/lib/engine/store';
import EChart from '../charts/EChart';
import styles from './MonteCarlo.module.css';

const COLORS = ['#4d8dff', '#ffb020', '#4ade80', '#c084fc', '#f472b6', '#22d3ee', '#fb923c', '#a3e635', '#94a3b8', '#64748b'];

const METRICS: { id: McMetric; label: string; pct: boolean }[] = [
  { id: 'cagr', label: 'CAGR', pct: true },
  { id: 'total_return', label: 'Rendement total', pct: true },
  { id: 'max_dd', label: 'Drawdown max', pct: true },
  { id: 'sharpe', label: 'Sharpe', pct: false },
  { id: 'sortino', label: 'Sortino', pct: false },
  { id: 'calmar', label: 'Calmar', pct: false },
  { id: 'vol', label: 'Volatilité', pct: true },
];

const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`);
const num = (v: number | null | undefined, d = 2) => (v === null || v === undefined ? '—' : v.toFixed(d));
const fmt = (m: { pct: boolean }, v: number | null | undefined) => (m.pct ? pct(v) : num(v));

const SYNTH_FIELDS: { key: keyof McSynthetic; label: string; step: number; tip: string; pct?: boolean }[] = [
  { key: 'alpha_sd', label: 'Edge réel des actions (σ annuel)', step: 0.05, pct: true, tip: '0 % = monde sans aucun edge : toute surperformance du momentum y est de la chance. Plus haut = certaines actions sont vraiment meilleures pendant un temps, ce que le momentum peut capter.' },
  { key: 'market_mu', label: 'Rendement du marché', step: 0.01, pct: true, tip: 'Rendement annuel moyen de l’indice simulé (équipondéré).' },
  { key: 'market_vol', label: 'Volatilité du marché', step: 0.01, pct: true, tip: 'Volatilité annuelle du facteur de marché commun.' },
  { key: 'idio_vol', label: 'Volatilité propre des actions', step: 0.02, pct: true, tip: 'Volatilité annuelle typique propre à chaque action (hors marché).' },
  { key: 'beta_sd', label: 'Dispersion des bêtas', step: 0.05, tip: 'Écart-type des bêtas autour de 1.' },
  { key: 'tail_df', label: 'Queues épaisses (ddl Student)', step: 1, tip: 'Plus bas = plus de gros mouvements. 4 est réaliste pour des actions individuelles.' },
  { key: 'crisis_per_year', label: 'Crises par an', step: 0.1, tip: 'Fréquence des régimes de crise (volatilité plus forte, dérive négative).' },
  { key: 'extreme_per_year', label: 'Chocs extrêmes / action / an', step: 0.01, pct: true, tip: 'Probabilité annuelle d’un saut brutal (+50 % à +300 % ou −30 % à −85 %) sur une action.' },
];

function useClient(): { client: EngineClient | null; outdated: boolean; ready: boolean } {
  const engine = useEngineStore((s) => s.engine);
  const status = useEngineStore((s) => s.status);
  const client = useMemo(() => (engine ? new EngineClient(engine.url, engine.health.auth_required) : null), [engine]);
  return { client, outdated: engineOutdated(engine?.health), ready: status !== 'detecting' };
}

export default function MonteCarloView() {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const { client, outdated } = useClient();
  const [opt, setOpt] = useState<McOptions>(MC_DEFAULTS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<McJob | null>(null);
  const [result, setResult] = useState<McResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [realCount, setRealCount] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);
  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set([...prev].filter((id) => portfolios.some((p) => p._id === id))) : new Set(portfolios.map((p) => p._id))));
  }, [portfolios]);
  useEffect(() => {
    if (opt.generator !== 'bootstrap' || !client || outdated) return;
    mcRealUniverse(client).then((r) => setRealCount(r.tickers.length)).catch(() => setRealCount(null));
  }, [opt.generator, client, outdated]);

  const running = job !== null && (job.status === 'queued' || job.status === 'running');
  const chosen = portfolios.filter((p) => selected.has(p._id));
  const set = <K extends keyof McOptions>(k: K, v: McOptions[K]) => setOpt((o) => ({ ...o, [k]: v }));
  const setSynth = (k: keyof McSynthetic, v: number) => setOpt((o) => ({ ...o, synthetic: { ...o.synthetic, [k]: v } }));

  const run = useCallback(async () => {
    if (!client || !chosen.length) return;
    setError(null);
    setResult(null);
    try {
      let j = await mcSubmit(client, chosen.map(toEngineConfig), opt);
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
      }, 700);
    } catch (e) {
      setJob(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, chosen, opt]);

  const cancel = () => {
    if (client && job) mcCancel(client, job.id).catch(() => {});
  };

  const estimate = opt.n_sims * opt.n_assets * opt.years * (chosen.length + 2);

  return (
    <div className={styles.wrap}>
      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Monte Carlo : tes portfolios sur des actions aléatoires</div>
            <div className={styles.sub}>
              Chaque simulation génère un univers d’actions fictives, y applique tous les portfolios choisis (mêmes configurations que dans Construire) et deux
              références équipondérées, puis on regarde la distribution des résultats : ce qui tient à la stratégie, ce qui tient à la chance.
            </div>
          </div>
        </div>

        <div className={styles.grid}>
          <label className={styles.field}>Simulations
            <input type="number" min={1} max={50000} value={opt.n_sims} onChange={(e) => set('n_sims', Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className={styles.field}>Actions par univers
            <input type="number" min={2} max={1000} value={opt.n_assets} onChange={(e) => set('n_assets', Math.max(2, Number(e.target.value) || 2))} />
          </label>
          <label className={styles.field}>Durée (années)
            <input type="number" min={1} max={50} step={1} value={opt.years} onChange={(e) => set('years', Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <label className={styles.field} title="Même graine = mêmes univers, résultats identiques et comparables d’un lancement à l’autre.">Graine aléatoire
            <input type="number" value={opt.seed} onChange={(e) => set('seed', Math.trunc(Number(e.target.value) || 0))} />
          </label>
          <label className={styles.field}>Coûts de transaction (bps)
            <input type="number" min={0} max={500} step={1} value={opt.cost_bps} onChange={(e) => set('cost_bps', Math.max(0, Number(e.target.value) || 0))} />
          </label>
          <label className={styles.field}>Taux sans risque
            <input type="number" step={0.005} value={opt.risk_free} onChange={(e) => set('risk_free', Number(e.target.value) || 0)} />
          </label>
          <label className={styles.field}>Univers aléatoire
            <select value={opt.generator} onChange={(e) => set('generator', e.target.value as McOptions['generator'])}>
              <option value="synthetic">Actions simulées (modèle)</option>
              <option value="bootstrap">Vrais rendements rééchantillonnés</option>
            </select>
          </label>
        </div>

        {opt.generator === 'synthetic' ? (
          <details className={styles.details}>
            <summary>Paramètres du modèle d’actions</summary>
            <div className={styles.grid}>
              {SYNTH_FIELDS.map((f) => (
                <label key={f.key} className={styles.field} title={f.tip}>{f.label}
                  <input type="number" step={f.step} value={opt.synthetic[f.key]} onChange={(e) => setSynth(f.key, Number(e.target.value) || 0)} />
                </label>
              ))}
            </div>
            <div className={styles.hint}>Les valeurs en % s’écrivent en décimales (0,07 = 7 %). Edge réel à 0 = « monde sans alpha » : sert à voir ce que ta stratégie donne quand rien n’est prévisible.</div>
          </details>
        ) : (
          <div className={styles.grid}>
            <label className={styles.field} title="Les rendements sont rééchantillonnés par blocs de jours consécutifs, partagés entre toutes les actions (garde les corrélations et les crises).">Longueur des blocs (jours)
              <input type="number" min={2} value={opt.bootstrap.block_days} onChange={(e) => set('bootstrap', { ...opt.bootstrap, block_days: Math.max(2, Number(e.target.value) || 21) })} />
            </label>
            <label className={styles.check} title="Retire le rendement moyen propre à chaque action (les gagnantes du passé ne le restent pas) : mesure ce que la stratégie fait sans biais de survivance.">
              <input type="checkbox" checked={opt.bootstrap.demean} onChange={(e) => set('bootstrap', { ...opt.bootstrap, demean: e.target.checked })} />
              Retirer la moyenne propre à chaque action
            </label>
            <div className={styles.hint}>
              Tire dans les historiques stockés sur ce moteur (≥ 3 ans){realCount !== null ? ` : ${realCount} tickers disponibles` : ''}. Demande au plus autant d’actions que de tickers.
            </div>
          </div>
        )}

        <div className={styles.pick}>
          <span className={styles.pickLabel}>Portfolios simulés :</span>
          {portfolios.map((p) => (
            <label key={p._id} className={styles.chip}>
              <input type="checkbox" checked={selected.has(p._id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(p._id); else n.delete(p._id); return n; })} />
              {p.name}
            </label>
          ))}
          {!portfolios.length && <span className={styles.hint}>Aucun portfolio : crée-en dans l’onglet Construire.</span>}
        </div>

        <div className={styles.actions}>
          {!running ? (
            <button type="button" className="btn btn-primary" disabled={!client || outdated || !chosen.length} onClick={run}
              title={!client ? 'Aucun moteur détecté' : outdated ? 'Mets le moteur à jour' : undefined}>
              Lancer {opt.n_sims.toLocaleString('fr-CA')} simulations
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={cancel}>Annuler</button>
          )}
          {estimate > 3e8 && !running && <span className={styles.warn}>Grosse simulation : prévois plusieurs minutes.</span>}
          {!client && <span className={styles.warn}>Moteur de calcul non détecté.</span>}
          {outdated && <span className={styles.warn}>Le moteur doit être mis à jour pour le Monte Carlo.</span>}
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

function McResults({ result }: { result: McResult }) {
  const [metricId, setMetricId] = useState<McMetric>('cagr');
  const [fanId, setFanId] = useState<string>(result.series[0]?.id ?? '');
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];
  const series = result.series;
  const color = (i: number) => COLORS[i % COLORS.length];
  const ports = series.filter((s) => s.kind === 'portfolio');
  const baseName = series.find((s) => s.kind === 'baseline')?.name ?? '';

  const histOption = useMemo(() => {
    const h = histogram(series.map((s) => s.metrics[metricId]), 40);
    const fmtAxis = (v: number) => (metric.pct ? `${(v * 100).toFixed(0)} %` : v.toFixed(2));
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 36, bottom: 30 },
      legend: { top: 0, type: 'scroll' },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `${Number(v).toFixed(1)} % des simulations` },
      xAxis: { type: 'category', data: h.centers.map((c) => fmtAxis(c)), axisLabel: { interval: 'auto' } },
      yAxis: { type: 'value', axisLabel: { formatter: '{value} %' } },
      series: series.map((s, i) => ({
        name: s.name, type: 'line', smooth: true, showSymbol: false, data: h.shares[i],
        lineStyle: { width: s.kind === 'baseline' ? 1.5 : 2.2, type: s.kind === 'baseline' ? 'dashed' : 'solid', color: color(i) },
        itemStyle: { color: color(i) },
        areaStyle: s.kind === 'baseline' ? undefined : { opacity: 0.06, color: color(i) },
      })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, metricId]);

  const fanOption = useMemo(() => {
    const s = series.find((x) => x.id === fanId) ?? series[0];
    if (!s) return {};
    const i = series.indexOf(s);
    const f = s.fan;
    const dates = result.calendar.fan_dates;
    const diff = (a: (number | null)[], b: (number | null)[]) => a.map((v, k) => (v === null || b[k] === null ? null : v - (b[k] as number)));
    const stack = (name: string, data: (number | null)[], opacity: number, stackId?: string) => ({
      name, type: 'line', data, stack: stackId, showSymbol: false, silent: true,
      lineStyle: { width: 0 }, areaStyle: stackId ? { opacity, color: color(i) } : undefined, tooltip: { show: false },
    });
    return {
      animation: false,
      grid: { left: 56, right: 16, top: 30, bottom: 30 },
      legend: { top: 0, data: ['Médiane'] },
      tooltip: { trigger: 'axis', valueFormatter: (v: number) => `×${Number(v).toFixed(2)}` },
      xAxis: { type: 'category', data: dates, axisLabel: { formatter: (v: string) => v.slice(0, 4) } },
      yAxis: { type: 'log', min: 'dataMin', axisLabel: { formatter: (v: number) => `×${v}` } },
      series: [
        stack('p5', f.p5, 0, 'a'),
        stack('5–95 %', diff(f.p95, f.p5), 0.12, 'a'),
        stack('p25', f.p25, 0, 'b'),
        stack('25–75 %', diff(f.p75, f.p25), 0.25, 'b'),
        { name: 'Médiane', type: 'line', data: f.p50, showSymbol: false, lineStyle: { width: 2.2, color: color(i) }, itemStyle: { color: color(i) } },
      ],
    };
  }, [series, fanId, result.calendar.fan_dates]);

  return (
    <>
      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Conclusions</div>
            <div className={styles.sub}>
              {result.options.n_sims.toLocaleString('fr-CA')} univers × {result.options.n_assets} actions × {result.options.years} ans · {result.universe_note}{' '}
              Calculé en {result.elapsed_s.toFixed(1)} s.
            </div>
          </div>
        </div>
        <ul className={styles.concl}>
          {ports.map((s) => <li key={s.id}>{conclusion(s, baseName)}</li>)}
        </ul>
        {series.some((s) => s.warnings.length) && (
          <details className={styles.details}>
            <summary>Ce qui n’est pas reproduit en Monte Carlo</summary>
            {series.filter((s) => s.warnings.length).map((s) => (
              <div key={s.id} className={styles.warnBlock}><strong>{s.name}</strong><ul>{s.warnings.map((w, k) => <li key={k}>{w}</li>)}</ul></div>
            ))}
          </details>
        )}
      </section>

      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div className={styles.title}>Distribution</div>
          <select className={styles.select} value={metricId} onChange={(e) => setMetricId(e.target.value as McMetric)}>
            {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </div>
        <EChart option={histOption} height={320} />
      </section>

      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div className={styles.title}>Éventail de la valeur du portfolio (départ = 1)</div>
          <select className={styles.select} value={fanId} onChange={(e) => setFanId(e.target.value)}>
            {series.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <EChart option={fanOption} height={320} />
      </section>

      <section className={`card ${styles.card}`}>
        <div className={styles.title}>Résumé par portfolio</div>
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Portfolio</th>
                <th>CAGR médian</th><th>CAGR 5 %</th><th>CAGR 95 %</th>
                <th>Sharpe méd.</th><th>DD max méd.</th><th>DD max 5 % pire</th>
                <th>Gagne vs {shortName(baseName)} (CAGR)</th><th>Gagne (Sharpe)</th><th>DD plus petit</th>
                <th>CAGR &gt; 0</th><th>A perdu de l’argent</th><th>DD &gt; 50 %</th>
                <th>Rotation / an</th><th>Positions</th><th>Cash</th>
              </tr>
            </thead>
            <tbody>
              {series.map((s, i) => (
                <tr key={s.id} className={s.kind === 'baseline' ? styles.base : undefined}>
                  <td><span className={styles.dot} style={{ background: color(i) }} />{s.name}</td>
                  <td className={styles.n}>{pct(s.summary.cagr.p50)}</td>
                  <td className={styles.n}>{pct(s.summary.cagr.p5)}</td>
                  <td className={styles.n}>{pct(s.summary.cagr.p95)}</td>
                  <td className={styles.n}>{num(s.summary.sharpe.p50)}</td>
                  <td className={styles.n}>{pct(s.summary.max_dd.p50)}</td>
                  <td className={styles.n}>{pct(s.summary.max_dd.p5)}</td>
                  <td className={styles.n}>{pct(s.probabilities?.beats_baseline_cagr, 0)}</td>
                  <td className={styles.n}>{pct(s.probabilities?.beats_baseline_sharpe, 0)}</td>
                  <td className={styles.n}>{pct(s.probabilities?.smaller_drawdown_than_baseline, 0)}</td>
                  <td className={styles.n}>{pct(s.probabilities?.positive_cagr, 0)}</td>
                  <td className={styles.n}>{pct(s.probabilities?.lost_money, 0)}</td>
                  <td className={styles.n}>{pct(s.probabilities?.drawdown_over_50, 0)}</td>
                  <td className={styles.n}>{pct(s.summary.turnover.p50, 0)}</td>
                  <td className={styles.n}>{num(s.summary.avg_holdings.mean, 1)}</td>
                  <td className={styles.n}>{pct(s.summary.cash_pct.mean, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className={styles.hint}>« Gagne » = part des univers où le portfolio bat la référence équipondérée sur le <em>même</em> univers (comparaison appariée). Les valeurs 5 % / 95 % sont des percentiles de la distribution.</div>
      </section>

      {result.pairwise_cagr.names.length > 1 && (
        <section className={`card ${styles.card}`}>
          <div className={styles.title}>Qui bat qui (CAGR, même univers)</div>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead><tr><th>Ligne bat colonne</th>{result.pairwise_cagr.names.map((n) => <th key={n}>{n}</th>)}</tr></thead>
              <tbody>
                {result.pairwise_cagr.names.map((n, i) => (
                  <tr key={n}>
                    <td>{n}</td>
                    {result.pairwise_cagr.matrix[i].map((v, j) => (
                      <td key={j} className={styles.n} style={v === null ? undefined : { background: `rgba(77,141,255,${Math.abs(v - 0.5) * 0.6})` }}>{v === null ? '—' : pct(v, 0)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function shortName(n: string): string {
  return n.replace('Équipondéré', 'équipond.').replace(' (mensuel)', '');
}

function conclusion(s: McSeries, baseName: string): string {
  const p = s.probabilities;
  if (!p) return s.name;
  const cagr = s.summary.cagr;
  const win = p.beats_baseline_cagr;
  const verdict =
    win === null ? '' : win > 0.65 ? 'bat nettement' : win > 0.55 ? 'bat légèrement' : win >= 0.45 ? 'fait à peu près jeu égal avec' : win >= 0.35 ? 'est légèrement derrière' : 'est nettement derrière';
  return `${s.name} : CAGR médian ${pct(cagr.p50)} (90 % des cas entre ${pct(cagr.p5)} et ${pct(cagr.p95)}), drawdown médian ${pct(s.summary.max_dd.p50, 0)}. `
    + (win === null ? '' : `Il ${verdict} « ${baseName} » dans ${pct(win, 0)} des univers (sur le même univers). `)
    + `Il a perdu de l’argent dans ${pct(p.lost_money, 0)} des cas.`;
}
