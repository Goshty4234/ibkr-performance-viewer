'use client';

import { useState } from 'react';
import { DEFAULT_OPTIONS, exportPortfolioJson, FREQUENCY_LABELS, normalizeImported } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import type { PortfolioConfig, RunOptions } from '@/lib/engine/types';
import styles from './Results.module.css';

const pct = (v: unknown) => `${((Number(v) || 0) * 100).toFixed(Number(v) * 100 % 1 ? 1 : 0)} %`;
const money = (v: unknown) => (Number(v) || 0).toLocaleString('fr-CA', { maximumFractionDigits: 0 });

function describeAssets(p: PortfolioConfig): string {
  if (p.fusion_portfolio?.enabled) {
    const f = p.fusion_portfolio;
    return `Fusion : ${f.selected_portfolios.map((n) => `${n} ${pct(f.allocations[n])}`).join(', ')}`;
  }
  const stocks = p.stocks.filter((s) => s.ticker.trim());
  if (p.use_momentum) return stocks.map((s) => s.ticker).join(', ');
  return stocks.map((s) => `${s.ticker} ${pct(s.allocation)}`).join(', ');
}

function describeRules(p: PortfolioConfig): string {
  const parts = [`Rebal. ${FREQUENCY_LABELS[p.rebalancing_frequency] ?? p.rebalancing_frequency}`];
  if (p.fusion_portfolio?.enabled) return parts[0];
  if (p.use_momentum) {
    const w = (p.momentum_windows ?? []).map((x) => x.lookback).join('/');
    parts.push(`momentum ${p.momentum_strategy ?? 'Classic'}${w ? ` ${w} j` : ''}`);
  }
  if (p.use_sma_filter) parts.push('filtre MA');
  if (p.use_targeted_rebalancing && !p.use_momentum && !p.use_sma_filter) parts.push('rebal. ciblé');
  parts.push(`${money(p.initial_value)} $ + ${money(p.added_amount)} $ ${FREQUENCY_LABELS[p.added_frequency]?.toLowerCase() ?? p.added_frequency}`);
  return parts.join(' · ');
}

function describeOptions(o: Partial<RunOptions>): string[] {
  const opts = { ...DEFAULT_OPTIONS, ...o };
  return [
    opts.start_with === 'oldest' ? 'Début : actif le plus ancien' : 'Début : tous les actifs disponibles',
    opts.first_rebalance_strategy === 'momentum_window_complete' ? '1er rebal. : fenêtre momentum complète' : '1er rebal. : date de rebalancement',
    opts.start_date || opts.end_date ? `Dates : ${opts.start_date ?? '…'} → ${opts.end_date ?? 'aujourd’hui'}` : 'Dates : période maximale',
  ];
}

export default function HistorySetup({
  portfolios,
  options,
  simulationEnd,
}: {
  portfolios: PortfolioConfig[];
  options: Partial<RunOptions>;
  simulationEnd: string | null;
}) {
  const importJson = useBacktestStore((s) => s.importJson);
  const setOptions = useBacktestStore((s) => s.setOptions);
  const currentEnd = useBacktestStore((s) => s.options.end_date);
  const [flash, setFlash] = useState<string | null>(null);

  const toJson = (p: PortfolioConfig) => exportPortfolioJson(normalizeImported(p as unknown as Record<string, unknown>), { ...DEFAULT_OPTIONS, ...options });
  const notify = (msg: string) => {
    setFlash(msg);
    setTimeout(() => setFlash(null), 1600);
  };

  return (
    <div className={styles.setupBox}>
      <div className={styles.setupOptions}>
        {describeOptions(options).map((t) => <span key={t} className={styles.historyTag}>{t}</span>)}
        {flash && <span className={styles.setupFlash}>{flash}</span>}
        {simulationEnd && (
          <button
            type="button"
            className={`btn btn-ghost btn-sm ${styles.setupEndBtn}`}
            disabled={currentEnd === simulationEnd}
            title="Les prochains runs du constructeur s’arrêteront à cette date : comparaison sur exactement la même fenêtre"
            onClick={() => { setOptions({ end_date: simulationEnd }); notify(`Fin du constructeur fixée au ${simulationEnd}`); }}
          >
            {currentEnd === simulationEnd ? `✓ Fin fixée au ${simulationEnd}` : `Arrêter mes runs au ${simulationEnd}`}
          </button>
        )}
      </div>
      {portfolios.map((p) => (
        <div key={p.name} className={styles.setupRow}>
          <div className={styles.setupMain}>
            <span className={styles.setupName}>{p.name}</span>
            <span className={styles.setupAssets} title={describeAssets(p)}>{describeAssets(p)}</span>
            <span className={styles.setupRules}>{describeRules(p)}</span>
          </div>
          <div className={styles.setupActions}>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => { await navigator.clipboard.writeText(toJson(p)); notify(`JSON de « ${p.name} » copié`); }}
            >
              Copier JSON
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title="Ajoute ce portfolio (renommé si le nom existe déjà) sans toucher aux autres"
              onClick={() => { importJson(toJson(p), 'append'); notify(`« ${p.name} » ajouté au constructeur`); }}
            >
              + Constructeur
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
