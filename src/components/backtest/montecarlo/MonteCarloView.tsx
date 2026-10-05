'use client';

import { Fragment, useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { ChartsResult } from '@/lib/backtest/analytics';
import { portfolioColor, portfolioSeriesId } from '@/lib/backtest/chart-data';
import { toEngineConfig } from '@/lib/backtest/portfolio';
import { okSummaries } from '@/lib/backtest/result-data';
import { useBacktestStore } from '@/lib/backtest/store';
import { useAnalytics } from '@/lib/backtest/worker/use-analytics';
import type { ChartBrushSelection } from '@/lib/chart-range';
import { EngineClient, engineOutdated } from '@/lib/engine/client';
import {
  daysBetween, histogram, mcCancel, mcCheck, mcSubmit, pairOf, parseTickers, windowOf,
  type McJob, type McOptions, type McResult, type McStatKey, type McUniverseSource, type McVerdict, type McWindow,
} from '@/lib/engine/montecarlo';
import { followJob, isFollowing, setMc, useMcSession, type Update } from '@/lib/engine/mc-session';
import { useEngineStore } from '@/lib/engine/store';
import EChart from '../charts/EChart';
import EngineUpdate from '../EngineUpdate';
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

const KIND_LABEL: Record<string, string> = { momentum: 'momentum', equal_weight: 'équipondéré' };
const KIND_TIP: Record<string, string> = {
  momentum: 'Stratégie momentum : elle choisit parmi les actions tirées, comme dans un run normal.',
  equal_weight: 'Pondérations égales : traité comme un panier équipondéré des actions tirées.',
};

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
  // Everything the page shows lives in a store outside the component (see mc-session.ts): leaving the tab, a rebuild of the
  // page or a re-render never loses the settings, the ticked portfolios, the running job or its result.
  const opt = useMcSession((s) => s.opt);
  const listText = useMcSession((s) => s.listText);
  const selected = useMcSession((s) => s.selected);
  const job = useMcSession((s) => s.job);
  const result = useMcSession((s) => s.result);
  const error = useMcSession((s) => s.error);
  const setOpt = useCallback((u: Update<McOptions>) => setMc('opt', u), []);
  const setListText = useCallback((u: Update<string>) => setMc('listText', u), []);
  const setSelected = useCallback((u: Update<Set<string>>) => setMc('selected', u), []);
  const setJob = useCallback((u: Update<McJob | null>) => setMc('job', u), []);
  const setResult = useCallback((u: Update<McResult | null>) => setMc('result', u), []);
  const setError = useCallback((u: Update<string | null>) => setMc('error', u), []);
  useEffect(() => {
    setSelected((prev) => (prev.size ? new Set([...prev].filter((id) => portfolios.some((p) => p._id === id))) : new Set(portfolios.map((p) => p._id))));
  }, [portfolios]);

  const running = job !== null && (job.status === 'queued' || job.status === 'running');
  const chosen = useMemo(() => portfolios.filter((p) => selected.has(p._id)), [portfolios, selected]);
  // Every portfolio is checked (not only the ticked ones): ticking or unticking never triggers a new check, so tags and
  // messages stay exactly where they are.
  const allConfigs = useMemo(() => portfolios.map(toEngineConfig), [portfolios]);
  // What the engine thinks of each chosen portfolio (momentum / equal weight are kept, the rest left out and explained).
  // Verdicts are remembered per portfolio (settings + stocks per draw), so ticking or unticking one never makes the others
  // disappear and come back: only a portfolio never checked is asked for. Until every chosen portfolio has its verdict
  // (or if the engine cannot answer) nothing can be launched, so a portfolio that makes no sense here can never slip through.
  const keys = useMemo(() => allConfigs.map((c) => JSON.stringify([c, opt.n_pick])), [allConfigs, opt.n_pick]);
  const [cache, setCache] = useState<Record<string, McVerdict>>({});
  const [checkError, setCheckError] = useState<string | null>(null);
  useEffect(() => {
    if (!client || outdated) return;
    const missing = allConfigs.map((c, i) => ({ c, key: keys[i] })).filter((x) => !cache[x.key]);
    if (!missing.length) { setCheckError(null); return; }
    let alive = true;
    const t = setTimeout(() => {
      mcCheck(client, missing.map((x) => x.c), { n_pick: opt.n_pick })
        .then((v) => {
          if (!alive) return;
          if (v.length !== missing.length) { setCheckError('Réponse inattendue du moteur.'); return; }
          setCheckError(null);
          setCache((prev) => {
            const next = { ...prev };
            missing.forEach((x, i) => { next[x.key] = v[i]; });
            return next;
          });
        })
        .catch((e: unknown) => { if (alive) setCheckError(e instanceof Error ? e.message : String(e)); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [client, outdated, allConfigs, keys, cache, opt.n_pick]);
  const known = keys.map((k) => cache[k]);
  const chosenKnown = portfolios.map((p, i) => (selected.has(p._id) ? known[i] : null)).filter((v) => v !== null);
  const verdicts: McVerdict[] | null = chosen.length > 0 && chosenKnown.every(Boolean) ? (chosenKnown as McVerdict[]) : null;
  // What is shown: every verdict already known, in a fixed order (the unticked ones are only greyed).
  const shownVerdicts = known.map((v, i) => (v ? { v, i, on: selected.has(portfolios[i]._id) } : null)).filter((x): x is { v: McVerdict; i: number; on: boolean } => x !== null);
  const verdictOf = (i: number): McVerdict | undefined => known[i];
  const usable = useMemo(
    () => (verdicts ? chosen.filter((_, i) => verdicts[i]?.status === 'included') : []),
    [chosen, verdicts],
  );
  const set = <K extends keyof McOptions>(k: K, v: McOptions[K]) => setOpt((o) => ({ ...o, [k]: v }));
  const listTickers = useMemo(() => parseTickers(listText), [listText]);
  const portfolioTickers = useMemo(
    () => [...new Set(usable.flatMap((p) => p.stocks.map((s) => s.ticker.trim().toUpperCase()).filter((t) => t && t !== 'CASH')))],
    [usable],
  );
  const universeCount = opt.universe.source === 'list' ? listTickers.length : opt.universe.source === 'portfolios' ? portfolioTickers.length : null;
  const tooSmall = universeCount !== null && universeCount < opt.n_pick;
  const runsPerDraw = usable.length + (opt.baseline ? 1 : 0);

  const run = useCallback(async () => {
    if (!client || !usable.length) return;
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
      const j = await mcSubmit(client, usable.map(toEngineConfig), options, mc);
      setJob(j);
      followJob(client, j.id);
    } catch (e) {
      setJob(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, usable, opt, listTickers, runOptions.first_rebalance_strategy, runOptions.auto_adjust_momentum_start]);

  // Back on the page while a job is still running (nobody is following it): follow it again.
  useEffect(() => {
    if (client && job && (job.status === 'queued' || job.status === 'running') && !isFollowing()) followJob(client, job.id);
  }, [client, job]);

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
          {portfolios.map((p) => {
            const v = verdictOf(portfolios.indexOf(p));
            const out = v?.status === 'excluded';
            return (
              <label key={p._id} className={`${styles.chip} ${out ? styles.chipOut : ''}`} title={out ? v?.reason ?? undefined : v ? KIND_TIP[v.kind ?? 'momentum'] : undefined}>
                <input type="checkbox" checked={selected.has(p._id)} onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(p._id); else n.delete(p._id); return n; })} />
                {p.name}
                {v && <span className={out ? styles.tagOut : styles.tagIn}>{out ? 'laissé de côté' : KIND_LABEL[v.kind ?? 'momentum']}</span>}
              </label>
            );
          })}
          {!portfolios.length && <span className={styles.hint}>Aucun portfolio : crée-en dans l’onglet Construire.</span>}
        </div>
        {shownVerdicts.some((x) => x.v.status === 'excluded' || x.v.notes.length > 0) && (
          <ul className={styles.verdicts}>
            {shownVerdicts.map(({ v, i, on }) => (
              <Fragment key={`${portfolios[i]._id}`}>
                {v.status === 'excluded' && <li className={styles.verdictOut} style={on ? undefined : { opacity: 0.45 }}><strong>{v.name}</strong> est laissé de côté. {v.reason}</li>}
                {v.status === 'included' && v.notes.map((n, k) => <li key={k} className={styles.verdictNote} style={on ? undefined : { opacity: 0.45 }}><strong>{v.name}</strong> : {n}</li>)}
              </Fragment>
            ))}
          </ul>
        )}
        {verdicts && usable.length === 0 && chosen.length > 0 && (
          <div className={styles.warn}>Aucun des portfolios cochés n’a de sens ici : il faut du momentum, ou une pondération égale entre les titres.</div>
        )}

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
        </div>

        <div className={styles.checks}>
          <label className={styles.check} title="Un portfolio momentum reste en cash le temps de remplir sa plus longue fenêtre, alors que la référence est investie dès le premier jour. Avec cette case, chaque tirage commence une fenêtre après sa plus ancienne action, pour tous les portfolios : on mesure tout le monde à partir du moment où le momentum peut acheter.">
            <input type="checkbox" checked={opt.align_momentum} onChange={(e) => set('align_momentum', e.target.checked)} />
            Départ commun : mesurer à partir du premier achat du momentum
          </label>
          <label className={styles.check} title="Ajoute à chaque tirage un portfolio équipondéré des mêmes actions, rebalancé chaque mois : la référence « sans stratégie ».">
            <input type="checkbox" checked={opt.baseline} onChange={(e) => set('baseline', e.target.checked)} />
            Référence équipondérée des actions tirées
          </label>
          <label className={styles.check} title="Une action n’est pas détenue avant la date où elle est entrée dans le S&P 500 (date de Wikipédia, actions actuelles de l’indice). Les autres titres (ETF…) restent toujours admis.">
            <input type="checkbox" checked={opt.filters.sp500_entry} onChange={(e) => set('filters', { ...opt.filters, sp500_entry: e.target.checked })} />
            Ignorer une action avant son entrée dans le S&P 500
          </label>
          <label className={styles.check} title="Une action n’est pas détenue tant que sa capitalisation de l’époque (nombre d’actions réel × cours) est sous le seuil.">
            <input type="checkbox" checked={opt.filters.min_cap} onChange={(e) => set('filters', { ...opt.filters, min_cap: e.target.checked })} />
            <span className={styles.capline}>
              Ignorer une action sous
              <input type="number" min={0} step={1} style={{ width: 70 }} value={opt.filters.min_cap_billions} disabled={!opt.filters.min_cap}
                onChange={(e) => set('filters', { ...opt.filters, min_cap_billions: Math.max(0, Number(e.target.value) || 0) })} />
              Md$ de capitalisation
            </span>
          </label>
        </div>
        {(opt.filters.sp500_entry || opt.filters.min_cap) && (
          <div className={styles.hint}>
            Ces filtres s’appliquent à tous les portfolios et à la référence. Une action pas encore admise est simplement laissée de côté (le
            tirage compte alors moins de titres à cette date, on n’en ajoute pas d’autres) : chaque tirage garde ses {opt.n_pick} actions, mais
            seules celles admises sont détenues.
          </div>
        )}

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
            <button type="button" className="btn btn-primary" disabled={!client || outdated || !usable.length || tooSmall} onClick={run}
              title={!client ? 'Aucun moteur détecté' : outdated ? 'Mets le moteur à jour' : tooSmall ? 'Univers plus petit que le nombre d’actions par tirage' : undefined}>
              Lancer {opt.n_draws.toLocaleString('fr-CA')} tirages
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={cancel}>Annuler</button>
          )}
          {chosen.length > 0 && !verdicts && !outdated && client && (
            <span className={checkError ? styles.warn : styles.faint}>{checkError ? `Vérification des portfolios impossible : ${checkError}` : 'Vérification des portfolios…'}</span>
          )}
          {tooSmall && <span className={styles.warn}>L’univers compte {universeCount} tickers : moins que {opt.n_pick} actions par tirage.</span>}
          {!client && detecting && <span className={styles.warn}>Connexion au moteur… patiente.</span>}
          {!client && !detecting && <span className={styles.warn}>Moteur de calcul non détecté.</span>}
          {outdated && <span className={styles.warn}>Le moteur doit être mis à jour pour ce Monte Carlo :</span>}
          <EngineUpdate />
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

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const PRESETS: { label: string; years: number | null }[] = [
  { label: '1 an', years: 1 }, { label: '3 ans', years: 3 }, { label: '5 ans', years: 5 }, { label: '10 ans', years: 10 }, { label: 'Tout', years: null },
];

function McResults({ result }: { result: McResult }) {
  const [metricId, setMetricId] = useState<McStatKey>('CAGR');
  const [log, setLog] = useState(false);
  const [highlight, setHighlight] = useState<number | null>(null);
  // The real portfolios' curves (standard backtest of Construire) over the same period, drawn on top of the cloud.
  const [overlay, setOverlay] = useState<RealOverlay | null>(null);
  const [showReal, setShowReal] = useState(true);
  const series = result.series;
  const realResult = useBacktestStore((s) => s.result);
  const realPfs = useMemo(() => (realResult ? okSummaries(realResult.summary) : []), [realResult]);
  // A portfolio keeps the colour it has in Résultats, so the real curve and its Monte Carlo cloud match.
  const color = (i: number) => {
    const real = realPfs.find((p) => p.name === series[i]?.name);
    return real && series[i].kind === 'portfolio' ? portfolioColor(real.index) : seriesColor(result, i);
  };

  // One period for everything: the real results, the Monte Carlo curves and the table below.
  const bounds = useMemo(() => {
    const all = [result.dates[0], result.dates[result.dates.length - 1], ...(realResult?.summary.dates.length ? [realResult.summary.dates[0], realResult.summary.dates[realResult.summary.dates.length - 1]] : [])].filter(Boolean).sort();
    return { min: all[0] ?? '', max: all[all.length - 1] ?? '' };
  }, [result, realResult]);
  const [start, setStart] = useState(bounds.min);
  const [end, setEnd] = useState(bounds.max);
  useEffect(() => { setStart(bounds.min); setEnd(bounds.max); }, [bounds]);
  // Debounce the two dates separately: a fresh {start, end} object at every render would re-arm the timer forever, rebuild the
  // chart options every 200 ms and reset whatever the user toggled in the legend.
  const dStart = useDebounced(start, 200);
  const dEnd = useDebounced(end, 200);
  const range = useMemo(() => ({ start: dStart, end: dEnd }), [dStart, dEnd]);
  const valid = !!range.start && !!range.end && range.start < range.end;
  const win: McWindow | null = useMemo(() => (valid ? windowOf(result, range.start, range.end) : null), [result, range, valid]);
  const [brush, setBrush] = useState<ChartBrushSelection | null>(null);
  useEffect(() => { setBrush(null); }, [range.start, range.end]);
  const setPreset = (years: number | null) => {
    setEnd(bounds.max);
    if (years === null) { setStart(bounds.min); return; }
    const d = new Date(`${bounds.max}T00:00:00Z`);
    d.setUTCFullYear(d.getUTCFullYear() - years);
    const sIso = d.toISOString().slice(0, 10);
    setStart(sIso < bounds.min ? bounds.min : sIso);
  };
  const metric = METRICS.find((m) => m.id === metricId) ?? METRICS[0];
  const ports = series.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'portfolio');
  const baseIdx = series.findIndex((s) => s.kind === 'baseline');
  const nDraws = result.draws.length;
  const shownDraws = Math.min(nDraws, MAX_DRAWN_CURVES);

  const curvesOption = useMemo(() => {
    if (!win) return {};
    // Re-based curves (1 = first day of the period). Linear: gain in %. Log: the growth multiple, labelled in %.
    const conv = (v: number | null) => (v === null || v === undefined ? null : log ? (v > 0 ? v : null) : (v - 1) * 100);
    const toPct = (v: number) => (log ? (v - 1) * 100 : v);
    const out: Record<string, unknown>[] = [];
    win.series.forEach((s, i) => {
      let drawn = 0;
      for (let d = 0; d < s.curves.length && drawn < shownDraws; d += 1) {
        const c = s.curves[d];
        if (!c) continue;
        drawn += 1;
        const hot = highlight === d;
        out.push({
          id: `c-${i}-${d}`, name: s.name, type: 'line', data: c.map(conv), showSymbol: false, silent: !hot,
          lineStyle: { width: hot ? 2.2 : 0.7, color: color(i), opacity: highlight === null ? 0.22 : hot ? 1 : 0.07 },
          itemStyle: { color: color(i) }, z: hot ? 5 : 1, emphasis: { disabled: true }, animation: false,
        });
      }
      out.push({
        id: `m-${i}`, name: s.name, type: 'line', data: s.fan.p50.map(conv), showSymbol: false,
        lineStyle: { width: 2.6, color: color(i), type: s.kind === 'baseline' ? 'dashed' : 'solid' }, itemStyle: { color: color(i) }, z: 4,
      });
    });
    const realNames: string[] = [];
    if (showReal && overlay && overlay.rows.length) {
      const dates = win.dates;
      for (const def of overlay.defs) {
        // Last known real value on or before each grid date, re-based on the first grid date like the cloud.
        const vals: (number | null)[] = [];
        let k = 0;
        let cur: number | null = null;
        for (const d of dates) {
          while (k < overlay.rows.length && overlay.rows[k].date <= d) {
            const v = overlay.rows[k][def.id];
            if (typeof v === 'number' && Number.isFinite(v)) cur = v;
            k += 1;
          }
          vals.push(cur);
        }
        const v0 = vals.find((v) => v !== null);
        if (v0 === undefined || v0 === null) continue;
        const growth = (v: number | null) => (v === null ? null : (1 + v / 100) / (1 + v0 / 100));
        const label = `${def.label} (réel)`;
        realNames.push(label);
        out.push({
          id: `r-${def.id}`, name: label, type: 'line', data: vals.map((v) => { const g = growth(v); return g === null ? null : conv(g); }),
          showSymbol: false, z: 8, emphasis: { disabled: true },
          lineStyle: { width: 3.6, color: def.color, shadowBlur: 8, shadowColor: 'rgba(0,0,0,0.6)' }, itemStyle: { color: def.color },
        });
      }
    }
    const span = win.dates.length > 1 ? daysBetween(win.dates[0], win.dates[win.dates.length - 1]) : 0;
    return {
      animation: false,
      grid: { left: 62, right: 18, top: 40, bottom: 34 },
      legend: { top: 0, type: 'scroll', data: [...win.series.map((s) => s.name), ...realNames] },
      tooltip: {
        trigger: 'axis',
        formatter: (params: { seriesId: string; seriesName: string; value: number | null; color: string; axisValue: string }[]) => {
          const rows = params.filter((p) => p.value !== null && p.value !== undefined && (p.seriesId.startsWith('m-') || p.seriesId.startsWith('r-') || (highlight !== null && p.seriesId.endsWith(`-${highlight}`) && p.seriesId.startsWith('c-'))));
          const head = `<div style="margin-bottom:4px">${params[0]?.axisValue ?? ''}</div>`;
          return head + rows.map((p) => `<div><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color};margin-right:6px"></span>${p.seriesName}${p.seriesId.startsWith('m-') ? ' (médiane)' : p.seriesId.startsWith('r-') ? '' : ` (tirage ${highlight! + 1})`} : ${pts(toPct(p.value as number), 1).replace(' pt', ' %')}</div>`).join('');
        },
      },
      xAxis: { type: 'category', data: win.dates, axisLabel: { formatter: (v: string) => (span > 365 * 4 ? v.slice(0, 4) : v.slice(0, 7)) } },
      yAxis: log
        ? { type: 'log', min: 'dataMin', axisLabel: { formatter: (v: number) => `${((v - 1) * 100).toFixed(0)} %` } }
        : { type: 'value', axisLabel: { formatter: (v: number) => `${v.toFixed(0)} %` } },
      series: out,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, log, highlight, shownDraws, realPfs, overlay, showReal]);

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
            <div className={styles.title}>Période affichée</div>
            <div className={styles.sub}>
              Choisis une date de début et une date de fin : tout repart de 0 % à la date de début, comme dans l’Analyse ciblée. Les
              graphiques de tes résultats réels, les courbes du Monte Carlo et le tableau « Sur la période » se règlent ensemble.
            </div>
          </div>
        </div>
        <div className={styles.period}>
          <label className={styles.field}>Début
            <input type="date" value={start} min={bounds.min} max={bounds.max} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className={styles.field}>Fin
            <input type="date" value={end} min={bounds.min} max={bounds.max} onChange={(e) => setEnd(e.target.value)} />
          </label>
          <div className={styles.presets}>
            {PRESETS.map((p) => <button key={p.label} type="button" className="btn btn-ghost btn-sm" onClick={() => setPreset(p.years)}>{p.label}</button>)}
          </div>
          {brush && (
            <>
              <button type="button" className="btn btn-secondary btn-sm" title="Les courbes repartent de 0 % au début de la sélection"
                onClick={() => { setStart(brush.startDate); setEnd(brush.endDate); setBrush(null); }}>
                Utiliser la sélection ({brush.startDate} → {brush.endDate})
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setBrush(null)}>✕ Effacer la sélection</button>
            </>
          )}
          {(start !== bounds.min || end !== bounds.max) && (
            <button type="button" className="btn btn-ghost btn-sm" title="Revenir à toute la période" onClick={() => setPreset(null)}>↺ Période complète</button>
          )}
        </div>
        {!valid && <div className={styles.warn}>La date de début doit précéder la date de fin.</div>}
      </section>

      <RealResults start={range.start} end={range.end} valid={valid} names={series.filter((s) => s.kind === 'portfolio').map((s) => s.name)}
        brush={brush} onBrush={setBrush} onOverlay={setOverlay} />

      <section className={`card ${styles.card}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Monte Carlo sur la même période (sans ajouts, 0 % au départ)</div>
            <div className={styles.sub}>
              Une ligne fine par tirage et par portfolio, la médiane en gras.
              {nDraws > shownDraws ? ` Les ${shownDraws} premiers tirages sont tracés (les statistiques couvrent les ${nDraws}).` : ''} Clique un tirage dans le tableau du bas pour le surligner.
              {win && win.series.some((s) => s.covered < nDraws) ? ` Seuls les tirages dont les actions existent déjà au début de la période sont gardés (${win.series.map((s) => `${shortName(s.name)} : ${s.covered}/${nDraws}`).join(', ')}).` : ''}
            </div>
          </div>
          <div className={styles.inline}>
            {overlay && overlay.defs.length > 0 && (
              <label className={styles.check} title="Trace par-dessus le nuage la courbe de ton vrai portfolio (backtest normal de Construire, avec ses propres actions), sur la même période et repartant de 0 %.">
                <input type="checkbox" checked={showReal} onChange={(e) => setShowReal(e.target.checked)} />Superposer mes résultats réels
              </label>
            )}
            <label className={styles.check}><input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} />Échelle log</label>
            {highlight !== null && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHighlight(null)}>Tirage {highlight + 1} ✕</button>}
          </div>
        </div>
        {win && win.series.some((s) => s.covered > 0)
          ? <EChart option={curvesOption} height={460} />
          : <div className={styles.warn}>Aucun tirage ne couvre cette période : choisis une période qui commence plus tard.</div>}
      </section>

      {win && win.series.some((s) => s.covered > 0) && (
        <section className={`card ${styles.card}`}>
          <div className={styles.title}>Sur la période choisie ({range.start} → {range.end})</div>
          <div className={styles.scroll}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Portfolio</th><th title="Tirages dont les actions existent au début de la période">Tirages</th>
                  <th>Rendement médian</th><th>Rendement 5 % – 95 %</th>
                  <th>CAGR médian</th><th>Drawdown max médian</th><th>Drawdown max (pire 5 %)</th>
                  <th title="Part des tirages où le rendement du portfolio dépasse celui de la référence équipondérée">Bat la référence</th>
                </tr>
              </thead>
              <tbody>
                {win.series.map((s, i) => (
                  <tr key={s.name} className={s.kind === 'baseline' ? styles.base : undefined}>
                    <td><span className={styles.dot} style={{ background: color(i) }} />{s.name}</td>
                    <td className={styles.n}>{s.covered}/{nDraws}</td>
                    <td className={styles.n}>{pct(s.ret.p50)}</td>
                    <td className={styles.n}>{pct(s.ret.p5, 0)} à {pct(s.ret.p95, 0)}</td>
                    <td className={styles.n}>{pct(s.cagr.p50)}</td>
                    <td className={styles.n}>{pct(s.drawdown.p50)}</td>
                    <td className={styles.n}>{pct(s.drawdown.p5)}</td>
                    <td className={styles.n} style={winStyle(win.beatBaseline[i])}>{share(win.beatBaseline[i])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className={styles.hint}>
            Mesuré sur les ~{win.gridPoints} points de la période (une grille régulière) : le drawdown et le CAGR sont donc très proches
            du calcul jour par jour sans être exactement identiques. Ce tableau est celui du Monte Carlo ; les chiffres exacts de tes
            vrais portfolios sont dans Résultats → Analyse ciblée.
          </div>
        </section>
      )}

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

/** The latest normal backtest of Construire (the real portfolios, their own stocks) over the chosen period, to compare with the cloud below. */
/** What the real-results charts hand to the Monte Carlo chart: the curves to overlay, in % since the period start. */
interface RealOverlay {
  defs: { id: string; label: string; color: string; kind: string }[];
  rows: { date: string; [id: string]: number | string | boolean | null | undefined }[];
}

function RealResults({ start, end, valid, names, brush, onBrush, onOverlay }: {
  start: string; end: string; valid: boolean; names: string[];
  brush: ChartBrushSelection | null; onBrush: (b: ChartBrushSelection | null) => void;
  onOverlay: (o: RealOverlay | null) => void;
}) {
  const real = useBacktestStore((s) => s.result);
  const pfs = useMemo(() => (real ? okSummaries(real.summary) : []), [real]);
  const benchKeys = useMemo(() => (real ? Object.keys(real.summary.benchmarks).sort() : []), [real]);
  const [benchmarks, setBenchmarks] = useState<string[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const namesKey = names.join('\u0001');
  useEffect(() => {
    setBenchmarks(benchKeys.slice(0, 1));
    const mine = pfs.filter((p) => names.includes(p.name));
    // Only the portfolios of this Monte Carlo are shown at first; if none matches by name, show them all.
    setHidden(new Set(mine.length ? pfs.filter((p) => !names.includes(p.name)).map((p) => portfolioSeriesId(p.index)) : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [real, benchKeys, pfs, namesKey]);
  const charts = useAnalytics<ChartsResult>(real, real && valid && pfs.length ? { op: 'rangeCharts', mode: 'no_additions', benchmarks, start, end } : null);
  const cd = charts.data?.charts ?? null;
  // The visible real portfolios (not the benchmarks) go to the Monte Carlo chart.
  useEffect(() => {
    onOverlay(cd ? { defs: cd.defs.filter((d) => d.kind !== 'benchmark' && !hidden.has(d.id)), rows: cd.pctData } : null);
  }, [cd, hidden, onOverlay]);
  const firstDay = cd?.pctData[0]?.date;
  const lastDay = cd?.pctData[cd.pctData.length - 1]?.date;

  // Headless: the real curves only feed the overlay of the Monte Carlo chart below, nothing is drawn here.
  void firstDay; void lastDay; void onBrush; void brush;
  return null;
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

