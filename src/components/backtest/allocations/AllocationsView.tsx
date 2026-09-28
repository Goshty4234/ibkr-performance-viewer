'use client';

import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { aiContext, downloadJson, useAllocationAnalysis } from '@/lib/backtest/allocations';
import { listRuns, loadLatestOnce, loadRun } from '@/lib/backtest/history';
import { okSummaries } from '@/lib/backtest/result-data';
import { useBacktestStore } from '@/lib/backtest/store';
import { FREQUENCY_LABELS, nextRebalance } from '@/lib/backtest/timer';
import { usePortfolioDetail } from '@/lib/backtest/use-detail';
import { SERIES_PALETTE } from '@/lib/chart-series';
import { useEngineStore } from '@/lib/engine/store';
import type { BenchmarkRow, FundamentalsReport, PieSlices, PortfolioSummaryOk, TimerInfo } from '@/lib/engine/types';
import DataGrid from '../grid/DataGrid';
import { AllocationHistorySection } from '../results/PortfolioTab';
import { AllocTable, Pie, PurchaseCalculator } from '../results/TodayTab';
import { money, num, pct } from '../results/format';
import { FUND_TABS, type FundTab, fundColumns, peColor } from './columns';
import styles from './Allocations.module.css';

type Tone = 'good' | 'fair' | 'warn' | 'bad' | 'neutral';

const SECTIONS = [
  { id: 'alloc-today', label: 'Cible du jour' },
  { id: 'alloc-fundamentals', label: 'Fondamentaux' },
  { id: 'alloc-risk', label: 'Risque & valorisation' },
  { id: 'alloc-composition', label: 'Composition' },
  { id: 'alloc-benchmarks', label: 'Benchmarks' },
  { id: 'alloc-history', label: 'Historique' },
];

function betaRating(b: number): [string, Tone] {
  if (b < 0.8) return ['Risque faible', 'good'];
  if (b < 1.2) return ['Risque équilibré', 'good'];
  if (b < 1.5) return ['Risque modéré', 'warn'];
  return ['Risque élevé', 'bad'];
}

function peRating(pe: number): [string, Tone] {
  if (pe < 15) return ['Sous-évalué', 'good'];
  if (pe < 25) return ['Juste valeur', 'fair'];
  if (pe < 35) return ['Cher', 'warn'];
  return ['Surévalué', 'bad'];
}

function yieldRating(y: number): [string, Tone] {
  if (y > 5) return ['Rendement très élevé', 'good'];
  if (y > 3) return ['Bon rendement', 'good'];
  if (y > 1.5) return ['Rendement modéré', 'fair'];
  return ['Rendement faible', 'neutral'];
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

// ---- small building blocks -------------------------------------------------------------

function Section({ id, title, sub, actions, children }: { id: string; title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={styles.section}>
      <div className={styles.sectionHead}>
        <div>
          <h2 className={styles.sectionTitle}>{title}</h2>
          {sub && <div className={styles.sectionSub}>{sub}</div>}
        </div>
        {actions && <div className={styles.sectionActions}>{actions}</div>}
      </div>
      {children}
    </section>
  );
}

function Kpi({ label, value, hint, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: Tone }) {
  return (
    <div className={`${styles.kpi} ${styles[`tone_${tone}`]}`}>
      <span className={styles.kpiLabel}>{label}</span>
      <strong className={styles.kpiValue}>{value}</strong>
      {hint && <span className={styles.kpiHint}>{hint}</span>}
    </div>
  );
}

function Skeleton({ height = 160 }: { height?: number }) {
  return <div className={styles.skeleton} style={{ height }} />;
}

function useNow(periodMs: number) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), periodMs);
    return () => clearInterval(t);
  }, [periodMs]);
  return now;
}

function compactUntil(ms: number): string {
  if (ms <= 0) return 'Aujourd’hui';
  const min = Math.floor(ms / 60_000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d > 0) return `${d} j ${h} h`;
  return h > 0 ? `${h} h ${min % 60} min` : `${min % 60} min`;
}

function TimerKpi({ timer }: { timer: TimerInfo | null }) {
  const now = useNow(30_000);
  if (!timer) return <Kpi label="Prochain rebalancement" value="—" hint="Aucun calendrier" />;
  const next = nextRebalance(timer.frequency, timer.last_rebalance, now);
  return (
    <Kpi
      label="Prochain rebalancement"
      value={next ? compactUntil(next.msUntil) : 'Aucun'}
      hint={next ? `${next.date.toLocaleDateString('fr-CA')} · ${FREQUENCY_LABELS[timer.frequency] ?? timer.frequency}` : FREQUENCY_LABELS[timer.frequency] ?? timer.frequency}
      tone="neutral"
    />
  );
}

// ---- sections --------------------------------------------------------------------------

function FundamentalsSection({ report, loading, name }: { report: FundamentalsReport | null; loading: boolean; name: string }) {
  const [tab, setTab] = useState<FundTab>('overview');
  const def = FUND_TABS.find((t) => t.id === tab)!;
  const columns = useMemo(() => fundColumns(def.fields), [def]);
  return (
    <Section
      id="alloc-fundamentals"
      title="Fondamentaux des positions"
      sub={report ? `Données Yahoo Finance au ${report.as_of} · ${report.rows.length} position${report.rows.length > 1 ? 's' : ''} · cache 24 h` : 'Données Yahoo Finance'}
    >
      <div className={styles.pills} role="tablist">
        {FUND_TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`${styles.pill} ${tab === t.id ? styles.pillOn : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!report && loading ? (
        <Skeleton height={260} />
      ) : (
        <DataGrid
          columns={columns}
          rows={report?.rows ?? []}
          rowKey={(r) => r.ticker}
          rowHeight={34}
          maxHeight={560}
          initialSort={{ key: tab === 'overview' ? 'pct_of_portfolio' : 'ticker', dir: tab === 'overview' ? 'desc' : 'asc' }}
          csvName={`fondamentaux-${def.id}-${name}`}
          empty="Aucune donnée fondamentale (moteur hors ligne ou positions sans cotation)."
        />
      )}
    </Section>
  );
}

const WEIGHTED_GROUPS: { title: string; items: [string, string, 'ratio' | 'pct' | 'bn'][] }[] = [
  {
    title: 'Valorisation',
    items: [['pe', 'P/E', 'ratio'], ['forward_pe', 'P/E prévisionnel', 'ratio'], ['peg', 'PEG', 'ratio'], ['price_book', 'Cours / valeur comptable', 'ratio'],
      ['price_sales', 'Cours / ventes', 'ratio'], ['ev_ebitda', 'EV / EBITDA', 'ratio'], ['price_fcf', 'Cours / FCF', 'ratio'], ['fcf_yield', 'Rendement FCF', 'pct']],
  },
  {
    title: 'Rentabilité',
    items: [['roe', 'ROE', 'pct'], ['roa', 'ROA', 'pct'], ['roic', 'ROIC', 'pct'], ['profit_margin', 'Marge nette', 'pct'],
      ['operating_margin', 'Marge opérationnelle', 'pct'], ['gross_margin', 'Marge brute', 'pct']],
  },
  {
    title: 'Santé financière',
    items: [['debt_equity', 'Dette / capitaux propres', 'ratio'], ['current_ratio', 'Ratio courant', 'ratio'], ['quick_ratio', 'Ratio rapide', 'ratio'],
      ['interest_coverage', 'Couverture des intérêts', 'ratio']],
  },
  {
    title: 'Croissance & dividendes',
    items: [['revenue_growth', 'Croissance des revenus', 'pct'], ['earnings_growth', 'Croissance des bénéfices', 'pct'], ['eps_growth', 'Croissance du BPA', 'pct'],
      ['dividend_yield', 'Rendement du dividende', 'pct'], ['payout_ratio', 'Taux de distribution', 'pct'], ['dividend_growth_5y', 'Rendement moyen 5 ans', 'pct']],
  },
  {
    title: 'Taille & risque',
    items: [['market_cap_b', 'Capitalisation moyenne', 'bn'], ['enterprise_value_b', 'Valeur d’entreprise moyenne', 'bn'], ['beta', 'Bêta', 'ratio']],
  },
];

function fmtWeighted(v: number | null | undefined, kind: 'ratio' | 'pct' | 'bn'): string {
  if (!finite(v)) return 'N/A';
  return kind === 'pct' ? pct(v) : kind === 'bn' ? `$${v.toFixed(2)} B` : num(v);
}

function RiskSection({ report, loading }: { report: FundamentalsReport | null; loading: boolean }) {
  const w = report?.weighted ?? {};
  const beta = w.beta;
  const pe = w.pe;
  const fpe = w.forward_pe;
  const dy = w.dividend_yield;
  const cards: { label: string; rating: [string, Tone] | null; detail: string }[] = [
    { label: 'Niveau de risque', rating: finite(beta) ? betaRating(beta) : null, detail: `Bêta ${finite(beta) ? beta.toFixed(2) : 'N/A'}` },
    { label: 'Valorisation actuelle', rating: finite(pe) ? peRating(pe) : null, detail: `P/E ${finite(pe) ? pe.toFixed(2) : 'N/A'}` },
    { label: 'Valorisation prévisionnelle', rating: finite(fpe) ? peRating(fpe) : null, detail: `P/E prévisionnel ${finite(fpe) ? fpe.toFixed(2) : 'N/A'}` },
    { label: 'Dividendes', rating: finite(dy) ? yieldRating(dy) : null, detail: `Rendement ${finite(dy) ? pct(dy) : 'N/A'}` },
  ];
  const notes: { tone: Tone; title: string; text: string }[] = [];
  if (finite(beta)) {
    if (beta < 0.8) notes.push({ tone: 'good', title: 'Portefeuille peu risqué', text: `Bêta ${beta.toFixed(2)} : volatilité inférieure au marché.` });
    else if (beta < 1.2) notes.push({ tone: 'fair', title: 'Risque modéré', text: `Bêta ${beta.toFixed(2)} : volatilité proche de la moyenne du marché.` });
    else notes.push({ tone: 'warn', title: 'Portefeuille risqué', text: `Bêta ${beta.toFixed(2)} : volatilité supérieure au marché.` });
  }
  if (finite(pe)) {
    if (pe < 15) notes.push({ tone: 'good', title: 'Portefeuille sous-évalué', text: `P/E ${pe.toFixed(2)} : valorisations attractives.` });
    else if (pe < 25) notes.push({ tone: 'fair', title: 'Valorisation raisonnable', text: `P/E ${pe.toFixed(2)} : valorisations dans la norme.` });
    else notes.push({ tone: 'warn', title: 'Potentiellement surévalué', text: `P/E ${pe.toFixed(2)} : valorisations élevées.` });
  }

  return (
    <Section id="alloc-risk" title="Risque & valorisation" sub="Moyennes pondérées par le poids de chaque position (P/E et PEG hors (0, 1000], bêta hors [-5, 5] et ratios négatifs exclus)">
      {!report && loading ? (
        <Skeleton height={120} />
      ) : (
        <>
          <div className={styles.riskGrid}>
            {cards.map((c) => (
              <div key={c.label} className={`${styles.riskCard} ${styles[`tone_${c.rating?.[1] ?? 'neutral'}`]}`}>
                <span className={styles.riskLabel}>{c.label}</span>
                <strong className={styles.riskValue}>{c.rating?.[0] ?? 'N/A'}</strong>
                <span className={styles.riskDetail}>{c.detail}</span>
              </div>
            ))}
          </div>
          {notes.length > 0 && (
            <div className={styles.notes}>
              {notes.map((n) => (
                <div key={n.title} className={`${styles.note} ${styles[`tone_${n.tone}`]}`}>
                  <strong>{n.title}</strong> — {n.text}
                </div>
              ))}
            </div>
          )}
          <div className={styles.weightedGrid}>
            {WEIGHTED_GROUPS.map((g) => (
              <div key={g.title} className={styles.weightedGroup}>
                <div className={styles.weightedTitle}>{g.title}</div>
                {g.items.map(([key, label, kind]) => {
                  const v = w[key];
                  return (
                    <div key={key} className={styles.weightedRow}>
                      <span>{label}</span>
                      <strong style={key === 'pe' || key === 'forward_pe' ? peColor(v) : undefined} className={finite(v) ? '' : styles.faint}>
                        {fmtWeighted(v, kind)}
                      </strong>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function Breakdown({ title, data }: { title: string; data: [string, number][] }) {
  const slices = useMemo<PieSlices>(() => data.filter(([, v]) => v > 0), [data]);
  const max = slices[0]?.[1] ?? 1;
  return (
    <div className={styles.breakdown}>
      <div className={styles.breakdownTitle}>{title}</div>
      <div className={styles.breakdownBody}>
        <Pie slices={slices} height={260} labels={false} />
        <div className={styles.barList}>
          {slices.map(([name, v], i) => (
            <div key={name} className={styles.barRow} title={`${name} : ${v.toFixed(2)}%`}>
              <span className={styles.barName}>
                <i style={{ background: SERIES_PALETTE[i % SERIES_PALETTE.length] }} />
                {name}
              </span>
              <span className={styles.barTrack}>
                <span style={{ width: `${(v / max) * 100}%`, background: SERIES_PALETTE[i % SERIES_PALETTE.length] }} />
              </span>
              <span className={styles.barValue}>{v.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CompositionSection({ report, loading }: { report: FundamentalsReport | null; loading: boolean }) {
  return (
    <Section id="alloc-composition" title="Composition" sub="Répartition de l’allocation cible par secteur et par industrie">
      {!report && loading ? (
        <Skeleton height={300} />
      ) : report ? (
        <div className={styles.twoCol}>
          <Breakdown title="Secteurs" data={report.sectors} />
          <Breakdown title="Industries" data={report.industries} />
        </div>
      ) : (
        <div className={styles.emptyLine}>Composition indisponible sans les fondamentaux.</div>
      )}
    </Section>
  );
}

const PERIOD_COLS: [keyof BenchmarkRow, string][] = [['1W', '1 sem.'], ['1M', '1 mois'], ['3M', '3 mois'], ['6M', '6 mois'], ['1Y', '1 an']];

function signed(v: number | null) {
  if (!finite(v)) return <span className={styles.faint}>N/A</span>;
  return <span style={{ color: v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : undefined }}>{`${v > 0 ? '+' : ''}${v.toFixed(2)}%`}</span>;
}

function BenchmarksSection({ rows, loading, name }: { rows: BenchmarkRow[] | null; loading: boolean; name: string }) {
  return (
    <Section id="alloc-benchmarks" title="Comparaison aux benchmarks" sub="Rendements de prix approximatifs sur des périodes calendaires · volatilité annualisée sur 365 jours · bêta vs SPY (portefeuille : vs son benchmark)">
      {!rows && loading ? (
        <Skeleton height={300} />
      ) : rows?.length ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Ticker</th>
                <th>P/E</th>
                {PERIOD_COLS.map(([, l]) => <th key={l}>{l}</th>)}
                <th>Volatilité</th>
                <th>Bêta</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker} className={r.ticker === 'PORTFOLIO' ? styles.rowHighlight : ''}>
                  <td className={styles.tickerCell}>{r.ticker === 'PORTFOLIO' ? <>★ {name}</> : r.ticker}</td>
                  <td style={peColor(r.pe)}>{finite(r.pe) ? r.pe.toFixed(2) : <span className={styles.faint}>N/A</span>}</td>
                  {PERIOD_COLS.map(([k]) => <td key={k}>{signed(r[k] as number | null)}</td>)}
                  <td>{finite(r.volatility) ? `${r.volatility.toFixed(2)}%` : <span className={styles.faint}>N/A</span>}</td>
                  <td>{finite(r.beta) ? r.beta.toFixed(2) : <span className={styles.faint}>N/A</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={styles.emptyLine}>Comparaison indisponible.</div>
      )}
    </Section>
  );
}

function Methodology() {
  return (
    <details className={styles.method}>
      <summary>Sources et méthodologie</summary>
      <ul>
        <li><strong>Source</strong> : toutes les métriques financières viennent de Yahoo Finance (cache de 24 h par titre).</li>
        <li><strong>Moyennes du portefeuille</strong> : pondérées par le poids de chaque position ; une donnée manquante n’entre pas dans la moyenne.</li>
        <li><strong>P/E</strong> : &lt; 15 sous-évalué, 15–25 juste valeur, 25–35 cher, &gt; 35 surévalué.</li>
        <li><strong>PEG</strong> (P/E ÷ croissance des bénéfices) : &lt; 1 sous-évalué, 1–2 juste, &gt; 2 potentiellement surévalué.</li>
        <li><strong>Cours / valeur comptable</strong> : &lt; 1 potentiellement sous-évalué, 1–3 juste, &gt; 3 potentiellement surévalué.</li>
        <li><strong>Rendement du dividende</strong> : un rendement faible n’est pas forcément mauvais (titres de croissance).</li>
        <li><strong>Bêta</strong> : &lt; 0,8 faible, 0,8–1,2 équilibré, 1,2–1,5 modéré, &gt; 1,5 élevé.</li>
      </ul>
    </details>
  );
}

// ---- empty state -----------------------------------------------------------------------

function EmptyState({ onRun, running }: { onRun: (id: string) => void; running: boolean }) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const showResult = useBacktestStore((s) => s.showResult);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    loadLatestOnce()
      .then((hit) => {
        if (hit && !useBacktestStore.getState().result) showResult(hit.result, hit.row.id, hit.row.label);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [showResult]);

  async function loadLatest() {
    setLoading(true);
    setError('');
    try {
      const [latest] = await listRuns(1);
      if (!latest) throw new Error('Aucun run enregistré pour l’instant.');
      const { row, result } = await loadRun(latest.id);
      if (!result) throw new Error('Le résultat de ce run n’est plus disponible.');
      showResult(result, row.id, row.label);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className={styles.emptyCard}>
      <div className={styles.emptyIcon}>◔</div>
      <h2>Analyse d’allocation</h2>
      <p>
        Choisis un portfolio : le backtest calcule l’allocation cible d’aujourd’hui, puis la page ajoute les fondamentaux,
        la composition par secteur, le risque et la comparaison aux benchmarks.
      </p>
      <div className={styles.emptyList}>
        {portfolios.map((p) => (
          <button key={p._id} type="button" className={styles.emptyItem} disabled={running} onClick={() => onRun(p._id)}>
            <span className={styles.emptyName}>{p.name}</span>
            <span className={styles.emptyMeta}>
              {p.fusion_portfolio?.enabled ? 'Fusion' : `${p.stocks.filter((s) => s.ticker).length} titres`}
              {p.use_momentum ? ' · momentum' : ''}
            </span>
            <span className={styles.emptyGo}>Analyser →</span>
          </button>
        ))}
      </div>
      <div className={styles.emptyActions}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={loadLatest} disabled={loading}>
          {loading ? 'Chargement…' : 'Ou utiliser le dernier run enregistré'}
        </button>
      </div>
      {error && <div className={styles.errorLine}>{error}</div>}
    </div>
  );
}

// ---- page ------------------------------------------------------------------------------

export default function AllocationsView() {
  const result = useBacktestStore((s) => s.result);
  const runId = useBacktestStore((s) => s.resultRunId);
  const label = useBacktestStore((s) => s.resultLabel);
  const resultSource = useBacktestStore((s) => s.resultSource);
  const saveError = useBacktestStore((s) => s.saveError);
  const workspace = useBacktestStore((s) => s.portfolios);
  const runs = useBacktestStore((s) => s.runs);
  const startRun = useBacktestStore((s) => s.startRun);
  const openRun = useBacktestStore((s) => s.openRun);
  const launchError = useBacktestStore((s) => s.launchError);
  const client = useEngineStore((s) => s.client);

  const pfs = useMemo(() => (result ? okSummaries(result.summary) : []), [result]);
  const [selected, setSelected] = useState<number | null>(null);
  const p: PortfolioSummaryOk | null = pfs.find((x) => x.index === selected) ?? pfs[0] ?? null;
  useEffect(() => setSelected(null), [result]);

  const [pending, setPending] = useState<string | null>(null);
  const pendingRun = runs.find((r) => r.id === pending) ?? null;
  useEffect(() => {
    if (!pendingRun) return;
    if (pendingRun.phase === 'done') {
      setPending(null);
      void openRun(pendingRun.id);
    } else if (['error', 'cancelled'].includes(pendingRun.phase)) {
      setPending(null);
    }
  }, [pendingRun, openRun]);

  const run = async (ids: string[]) => {
    const id = await startRun(ids);
    if (id) setPending(id);
  };

  const { analysis, loading, error, saved, source, refresh } = useAllocationAnalysis(client, result, runId, label, p);
  const { detail } = usePortfolioDetail(result, p?.index ?? null);
  const report = analysis?.fundamentals ?? null;
  const running = !!pendingRun;
  const runProgress = pendingRun?.job ? Math.round((pendingRun.job.progress ?? 0) * 100) : 0;

  if (!result || !p) {
    return (
      <div className={styles.page}>
        {running && <div className={styles.progress}><span style={{ width: `${Math.max(4, runProgress)}%` }} />Backtest en cours… {runProgress}%</div>}
        {launchError && <div className={styles.errorLine}>{launchError}</div>}
        <EmptyState onRun={(id) => run([id])} running={running} />
      </div>
    );
  }

  const today = p.today ?? null;
  const pie: PieSlices = today?.pie?.length
    ? today.pie
    : Object.entries(p.today_weights ?? {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v * 100]);
  const positions = pie.filter(([t]) => t !== 'CASH').length;
  const w = report?.weighted ?? {};
  const wsMatch = workspace.find((x) => x.name === p.name) ?? null;
  const updated = analysis ? new Date(analysis.created_at) : null;

  const exportAi = () => {
    if (!analysis) return;
    const safe = p.name.replace(/[^\w-]+/g, '_').slice(0, 60);
    downloadJson(`allocations-${safe}-${analysis.created_at.slice(0, 10)}.json`, aiContext(analysis));
  };

  const print = () => {
    document.body.classList.add('print-allocations');
    const done = () => {
      document.body.classList.remove('print-allocations');
      window.removeEventListener('afterprint', done);
    };
    window.addEventListener('afterprint', done);
    window.print();
  };

  return (
    <div className={`${styles.page} alloc-print-root`}>
      <header className={styles.hero}>
        <div className={styles.heroMain}>
          <span className={styles.eyebrow}>Analyse d’allocation · {today ? 'rebalancement du jour' : 'poids actuels'}</span>
          <div className={styles.heroTitleRow}>
            <select className={styles.heroSelect} value={p.index} onChange={(e) => setSelected(Number(e.target.value))} aria-label="Portfolio">
              {pfs.map((x) => <option key={x.index} value={x.index}>{x.name}</option>)}
            </select>
            {p.fusion && <span className={styles.tag}>Fusion</span>}
            {p.config.use_momentum && <span className={styles.tag}>Momentum</span>}
          </div>
          <div className={styles.heroMeta}>
            <span>Run : {label || 'Backtest'}</span>
            {p.stats_display.CAGR && <span>CAGR {p.stats_display.CAGR}</span>}
            {p.stats_display.MaxDrawdown && <span>Drawdown max {p.stats_display.MaxDrawdown}</span>}
            {p.stats_display.Sharpe && <span>Sharpe {p.stats_display.Sharpe}</span>}
            {updated && (
              <span className={styles.status}>
                <i className={loading ? styles.dotBusy : saved === 'ok' ? styles.dotOk : saved === 'error' ? styles.dotErr : styles.dotIdle} />
                {loading
                  ? 'Mise à jour…'
                  : `Analyse du ${updated.toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })}${source === 'saved' ? ' (Supabase)' : ''}`}
                {saved === 'ok' && !loading && ' · enregistrée'}
                {saved === 'saving' && ' · enregistrement…'}
                {saved === 'error' && ' · non enregistrée'}
                {!runId && !loading && (resultSource === 'run' && !saveError
                  ? ' · enregistrement du run…'
                  : resultSource === 'file' ? ' · fichier local, non enregistrée' : ' · non enregistrée')}
              </span>
            )}
          </div>
        </div>
        <div className={styles.heroActions}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={refresh} disabled={loading || !client} title={client ? 'Recharger les fondamentaux et les benchmarks' : 'Moteur hors ligne'}>
            ↻ Actualiser
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => wsMatch && run([wsMatch._id])}
            disabled={!wsMatch || running}
            title={wsMatch ? 'Relance le backtest de ce portfolio avec les prix du jour' : 'Ce portfolio n’est plus dans l’espace de travail'}
          >
            {running ? `Backtest… ${runProgress}%` : '▶ Relancer le backtest'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportAi} disabled={!analysis} title="Paramètres + résultats dans un seul JSON (prêt pour une IA)">
            Export JSON
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={print}>PDF</button>
        </div>
      </header>

      {error && <div className={styles.errorLine}>{error}</div>}
      {launchError && <div className={styles.errorLine}>{launchError}</div>}
      {analysis?.errors.fundamentals && analysis.benchmarks && <div className={styles.warnLine}>Fondamentaux : {analysis.errors.fundamentals}</div>}
      {analysis?.errors.benchmarks && analysis.fundamentals && <div className={styles.warnLine}>Benchmarks : {analysis.errors.benchmarks}</div>}

      <div className={styles.kpis}>
        <Kpi label="Valeur du portefeuille" value={money(today?.portfolio_value ?? null, 0)} hint={`${positions} position${positions > 1 ? 's' : ''}${pie.some(([t]) => t === 'CASH') ? ' + cash' : ''}`} />
        <Kpi label="P/E pondéré" value={finite(w.pe) ? w.pe.toFixed(2) : loading ? '…' : 'N/A'} hint={finite(w.pe) ? peRating(w.pe)[0] : 'Valorisation'} tone={finite(w.pe) ? peRating(w.pe)[1] : 'neutral'} />
        <Kpi label="Bêta pondéré" value={finite(w.beta) ? w.beta.toFixed(2) : loading ? '…' : 'N/A'} hint={finite(w.beta) ? betaRating(w.beta)[0] : 'Risque'} tone={finite(w.beta) ? betaRating(w.beta)[1] : 'neutral'} />
        <Kpi label="Rendement du dividende" value={finite(w.dividend_yield) ? pct(w.dividend_yield) : loading ? '…' : 'N/A'} hint={finite(w.dividend_yield) ? yieldRating(w.dividend_yield)[0] : 'Pondéré'} />
        <Kpi label="Secteur principal" value={report?.sectors[0]?.[0] ?? (loading ? '…' : 'N/A')} hint={report?.sectors[0] ? `${report.sectors[0][1].toFixed(1)}% de l’allocation` : 'Composition'} />
        <TimerKpi timer={p.timer ?? null} />
      </div>

      <nav className={styles.sectionNav} aria-label="Sections">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {s.label}
          </button>
        ))}
      </nav>

      <Section
        id="alloc-today"
        title="Allocation cible aujourd’hui"
        sub={`Poids issus des dernières métriques${p.config.use_momentum ? ' de momentum' : ' de la configuration'} · actions arrondies au dixième au dernier prix connu`}
      >
        <div className={styles.todayGrid}>
          <div className={styles.pieBox}><Pie slices={pie} height={320} /></div>
          <div><AllocTable table={today?.table ?? null} /></div>
        </div>
      </Section>

      {today && Object.keys(today.weights).length > 0 && <PurchaseCalculator weights={today.weights} prices={today.prices} />}

      <FundamentalsSection report={report} loading={loading} name={p.name} />
      <RiskSection report={report} loading={loading} />
      <CompositionSection report={report} loading={loading} />
      <BenchmarksSection rows={analysis?.benchmarks ?? null} loading={loading} name={p.name} />

      <div id="alloc-history" className={styles.anchor}>
        {detail?.allocations && detail.allocations.dates.length > 0 ? (
          <AllocationHistorySection allocations={detail.allocations} />
        ) : (
          <Section id="alloc-history-empty" title="Allocations historiques">
            <div className={styles.emptyLine}>{detail ? 'Aucun historique d’allocation pour ce portfolio.' : 'Chargement de l’historique…'}</div>
          </Section>
        )}
      </div>

      <Methodology />
    </div>
  );
}
