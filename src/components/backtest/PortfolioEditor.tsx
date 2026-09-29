'use client';

import { useState } from 'react';
import {
  equalFusionAllocations,
  FREQUENCIES,
  FREQUENCY_LABELS,
  fusionName,
  MOMENTUM_STRATEGIES,
  NEGATIVE_STRATEGIES,
  normalizeWeights,
  PRESETS,
  type EditablePortfolio,
} from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import { DEFAULT_WINDOWS } from '@/lib/backtest/variants';
import type { MomentumWindow, TargetedSetting } from '@/lib/engine/types';
import { Check, InfoTip, NumField, NumInput, SelectField, TextField, Toggle } from './fields';
import { TIPS } from './tips';
import ImportExportDialog from './ImportExportDialog';
import LibraryDialog from './LibraryDialog';
import StocksTable from './StocksTable';
import VariantGenerator from './VariantGenerator';
import styles from './Backtester.module.css';

const FREQ_OPTIONS = FREQUENCIES.map((f) => ({ value: f as string, label: FREQUENCY_LABELS[f] }));
const MOMENTUM_OPTIONS = MOMENTUM_STRATEGIES.map((m) => ({
  value: m as string,
  label: m === 'Classic' ? 'Classique' : m === 'Relative Momentum' ? 'Momentum relatif' : 'Near-Zero Symmetry',
}));
const NEGATIVE_OPTIONS = NEGATIVE_STRATEGIES.map((m) => ({
  value: m as string,
  label: m === 'Cash' ? 'Aller en cash' : m === 'Equal weight' ? 'Poids égaux' : m === 'Relative momentum' ? 'Momentum relatif' : 'Near-Zero Symmetry',
}));

export default function PortfolioEditor() {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const selectedId = useBacktestStore((s) => s.selectedId);
  const p = portfolios.find((x) => x._id === selectedId) ?? portfolios[0];
  const update = useBacktestStore((s) => s.updatePortfolio);
  const rename = useBacktestStore((s) => s.renamePortfolio);
  const duplicate = useBacktestStore((s) => s.duplicatePortfolio);
  const remove = useBacktestStore((s) => s.removePortfolio);
  const move = useBacktestStore((s) => s.movePortfolio);
  const addPortfolio = useBacktestStore((s) => s.addPortfolio);
  const commitName = useBacktestStore((s) => s.commitName);
  const createFusion = useBacktestStore((s) => s.createFusion);
  const importJson = useBacktestStore((s) => s.importJson);
  const resetPortfolio = useBacktestStore((s) => s.resetPortfolio);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  if (!p) {
    return (
      <div className={`card ${styles.empty}`}>
        <h2>Aucun portfolio</h2>
        <p>Crée un portfolio ou importe le JSON exporté depuis Streamlit.</p>
        <button type="button" className="btn btn-primary" onClick={addPortfolio}>+ Nouveau portfolio</button>
      </div>
    );
  }

  const idx = portfolios.findIndex((x) => x._id === p._id);
  const set = (patch: Partial<EditablePortfolio>) => update(p._id, patch);
  const fusion = Boolean(p.fusion_portfolio?.enabled);
  const targeted = Boolean(p.use_targeted_rebalancing) && !p.use_momentum && !p.use_sma_filter;

  function quickAction(action: string) {
    if (action.startsWith('preset:')) {
      const preset = PRESETS.find((m) => `preset:${m.id}` === action);
      if (preset) importJson(JSON.stringify(preset.config), 'append');
      return;
    }
    switch (action) {
      case 'reset':
        if (confirm(`Remettre « ${p.name} » aux réglages par défaut (60/40 SPY/TLT, sans momentum) ? Le nom est conservé.`)) resetPortfolio(p._id);
        break;
      case 'spy':
      case 'spytr': {
        const tr = action === 'spytr';
        rename(p._id, tr ? 'SPY Total Return' : 'SPY Benchmark');
        set({
          stocks: [{ ticker: tr ? 'SPYTR' : 'SPY', allocation: 1, include_dividends: true, include_in_sma_filter: true }],
          use_momentum: false,
          added_amount: 10000,
          added_frequency: 'Annually',
        });
        commitName(p._id);
        break;
      }
      case 'windows':
        set({ momentum_windows: DEFAULT_WINDOWS.map((w) => ({ ...w })) });
        break;
      case 'normalize-windows': {
        const ws = p.momentum_windows ?? [];
        const total = ws.reduce((a, w) => a + (Number(w.weight) || 0), 0);
        if (total > 0) set({ momentum_windows: ws.map((w) => ({ ...w, weight: (Number(w.weight) || 0) / total })) });
        break;
      }
      case 'beta':
        set({ beta_window_days: 365, exclude_days_beta: 30, calc_beta: true });
        break;
      case 'vol':
        set({ vol_window_days: 365, exclude_days_vol: 30, calc_volatility: true });
        break;
      case 'fusion': {
        const names = portfolios.filter((x) => !x.fusion_portfolio?.enabled).map((x) => x.name);
        if (names.length < 2) { alert('Il faut au moins 2 portfolios normaux pour créer une fusion.'); break; }
        const alloc = equalFusionAllocations(names);
        const freq = portfolios[0]?.rebalancing_frequency ?? 'Monthly';
        createFusion(fusionName(alloc, freq), alloc, freq);
        break;
      }
    }
  }

  return (
    <div className={styles.editor}>
      <div className={`card ${styles.editorHead}`}>
        <input
          type="text"
          className={styles.nameInput}
          value={p.name}
          onChange={(e) => rename(p._id, e.target.value)}
          onBlur={() => commitName(p._id)}
          aria-label="Nom du portfolio"
        />
        <select
          value=""
          className={styles.quickSelect}
          aria-label="Actions rapides"
          onChange={(e) => { quickAction(e.target.value); e.target.value = ''; }}
        >
          <option value="" disabled>Actions…</option>
          <optgroup label="Portfolio">
            <option value="reset">Réinitialiser ce portfolio (réglages par défaut)</option>
            <option value="spy">Convertir en SPY (benchmark)</option>
            <option value="spytr">Convertir en SPY rendement total</option>
            <option value="fusion">Créer une fusion de tous les portfolios</option>
          </optgroup>
          <optgroup label="Ajouter un modèle">
            {PRESETS.map((m) => <option key={m.id} value={`preset:${m.id}`}>{m.label}</option>)}
          </optgroup>
          {!fusion && (
            <optgroup label="Momentum">
              <option value="normalize-windows">Normaliser les poids des fenêtres</option>
              <option value="windows">Réinitialiser les fenêtres (365/180/120)</option>
              <option value="beta">Réinitialiser la pondération bêta (365/30, activée)</option>
              <option value="vol">Réinitialiser la pondération volatilité (365/30, activée)</option>
            </optgroup>
          )}
        </select>
        <button type="button" className={styles.iconBtn} disabled={idx <= 0} onClick={() => move(p._id, -1)} title="Monter">↑</button>
        <button type="button" className={styles.iconBtn} disabled={idx >= portfolios.length - 1} onClick={() => move(p._id, 1)} title="Descendre">↓</button>
        <button type="button" className={styles.iconBtn} onClick={() => duplicate(p._id)} title="Dupliquer">⧉</button>
        <button type="button" className={styles.iconBtn} onClick={() => setJsonOpen(true)} title="JSON de ce portfolio (copier / télécharger)">{'{}'}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setLibraryOpen(true)} title="Garder cette configuration dans « Mes portfolios » pour la réutiliser plus tard (nom modifiable)">
          💾 Enregistrer
        </button>
        <button
          type="button"
          className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
          onClick={() => { if (confirm(`Supprimer « ${p.name} » ?`)) remove(p._id); }}
          title="Supprimer"
        >
          ✕
        </button>
      </div>
      {jsonOpen && <ImportExportDialog mode="export" portfolioId={p._id} onClose={() => setJsonOpen(false)} />}
      {libraryOpen && <LibraryDialog onClose={() => setLibraryOpen(false)} />}

      <div className={`${styles.editorCols} ${fusion ? styles.editorColsSingle : ''}`}>
      <div className={styles.editorCol}>
      <section className={`card ${styles.section}`}>
        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>Capital et flux</span>
        </div>
        <div className={styles.grid2}>
          <NumField label="Valeur initiale ($)" value={p.initial_value} min={0} step={1000} title={TIPS.initialValue} onChange={(v) => set({ initial_value: v })} />
          <NumField label="Ajout périodique ($)" value={p.added_amount} min={0} step={100} title={TIPS.addedAmount} onChange={(v) => set({ added_amount: v })} />
          <SelectField label="Fréquence des ajouts" value={p.added_frequency} options={FREQ_OPTIONS} title={TIPS.addedFrequency} onChange={(v) => set({ added_frequency: v })} />
          <SelectField label="Rebalancement" value={p.rebalancing_frequency} options={FREQ_OPTIONS} title={TIPS.rebalancing} onChange={(v) => set({ rebalancing_frequency: v })} />
          <TextField label="Benchmark" value={p.benchmark_ticker} mono title={TIPS.benchmark} onChange={(v) => set({ benchmark_ticker: v.toUpperCase() })} />
        </div>
        <div className={styles.grid2}>
          <Check checked={Boolean(p.collect_dividends_as_cash)} onChange={(v) => set({ collect_dividends_as_cash: v })} title={TIPS.dividendsCash}>
            Dividendes gardés en cash
          </Check>
          <Check checked={Boolean(p.idle_cash_earns_treasury_yield)} onChange={(v) => set({ idle_cash_earns_treasury_yield: v })} title={TIPS.idleCash}>
            Cash rémunéré (taux T-bill)
          </Check>
          <Check
            checked={fusion}
            onChange={(v) => set({ fusion_portfolio: { enabled: v, selected_portfolios: p.fusion_portfolio?.selected_portfolios ?? [], allocations: p.fusion_portfolio?.allocations ?? {} } })}
            title={TIPS.fusion}
          >
            Portfolio fusion
          </Check>
        </div>
        {idx > 0 && (
          <div className={styles.grid2}>
            <Check
              checked={Boolean(p.exclude_from_cashflow_sync)}
              onChange={(v) => set({ exclude_from_cashflow_sync: v })}
              title={TIPS.excludeCashflowSync}
            >
              Ne pas écraser par « ⇄ Apports »
            </Check>
            <Check
              checked={Boolean(p.exclude_from_rebalancing_sync)}
              onChange={(v) => set({ exclude_from_rebalancing_sync: v })}
              title={TIPS.excludeRebalSync}
            >
              Ne pas écraser par « ⇄ Rebalancement »
            </Check>
          </div>
        )}
      </section>

      {fusion ? <FusionSection p={p} /> : <StocksTable portfolio={p} />}
      </div>
      {!fusion && (
        <div className={styles.editorCol}>
          {targeted ? (
            <p className={`card ${styles.section} ${styles.hint}`}>
              Momentum et filtre MA masqués : le rebalancement ciblé est actif. Désactive-le pour les réafficher.
            </p>
          ) : (
            <>
              <MomentumSection p={p} set={set} />
              <MaSection p={p} set={set} />
            </>
          )}
          {!p.use_momentum && !p.use_sma_filter && <TargetedSection p={p} set={set} />}
          <AdvancedSection p={p} set={set} />
        </div>
      )}
      </div>
      {!fusion && <VariantGenerator p={p} />}
    </div>
  );
}

function TargetedSection({ p, set }: { p: EditablePortfolio; set: SetFn }) {
  const settings = p.targeted_rebalancing_settings ?? {};
  const tickers = [...new Set(p.stocks.map((s) => s.ticker).filter(Boolean))];
  const get = (t: string) => settings[t] ?? { enabled: false, min_allocation: 0, max_allocation: 100 };
  const patchTicker = (t: string, patch: Partial<TargetedSetting>) =>
    set({ targeted_rebalancing_settings: { ...settings, [t]: { ...get(t), ...patch } } });
  const on = Boolean(p.use_targeted_rebalancing);

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>
          <Toggle on={on} onChange={(v) => set({ use_targeted_rebalancing: v })} label="Activer le rebalancement ciblé" title={TIPS.targeted} />
          <span title={TIPS.targeted}>Rebalancement ciblé</span>
        </span>
        <span className={styles.sectionSub}>Rebalance seulement si un actif sort de sa bande min / max, vérifié aux dates prévues</span>
      </div>
      {on && (
        tickers.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <span className={styles.hint}>Exemple : TQQQ 40–70 % : au-dessus de 70 %, on vend pour acheter les autres ; sous 40 %, on rachète TQQQ.</span>
            <div className={styles.targetRow} style={{ fontSize: '0.7rem', color: 'var(--text-faint)', fontWeight: 700 }}>
              <span>TICKER</span><span>ACTIF</span><span>MIN %</span><span>MAX %</span>
            </div>
            {tickers.map((t) => {
              const s = get(t);
              const bad = s.enabled && s.min_allocation >= s.max_allocation;
              return (
                <div key={t}>
                  <div className={styles.targetRow}>
                    <span style={{ fontFamily: 'var(--mono)' }}>{t}</span>
                    <input type="checkbox" checked={s.enabled} onChange={(e) => patchTicker(t, { enabled: e.target.checked })} aria-label={`Activer ${t}`} />
                    <NumInput value={s.min_allocation} min={0} max={100} step={0.1} suffix="%" onChange={(v) => patchTicker(t, { min_allocation: v })} />
                    <NumInput value={s.max_allocation} min={0} max={100} step={0.1} suffix="%" onChange={(v) => patchTicker(t, { max_allocation: v })} />
                  </div>
                  {bad && <div className={styles.errorBox}>Min % doit être inférieur à Max % pour {t}.</div>}
                </div>
              );
            })}
          </div>
        ) : (
          <p className={styles.hint}>Ajoute des tickers pour configurer les bandes.</p>
        )
      )}
    </section>
  );
}

type SetFn = (patch: Partial<EditablePortfolio>) => void;

function FusionSection({ p }: { p: EditablePortfolio }) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const update = useBacktestStore((s) => s.updatePortfolio);
  const rename = useBacktestStore((s) => s.renamePortfolio);
  const commitName = useBacktestStore((s) => s.commitName);
  const f = p.fusion_portfolio ?? { enabled: true, selected_portfolios: [], allocations: {} };
  const candidates = portfolios.filter((x) => x._id !== p._id && !x.fusion_portfolio?.enabled);
  const total = f.selected_portfolios.reduce((s, n) => s + (Number(f.allocations[n]) || 0), 0) * 100;
  const totalOk = Math.abs(total - 100) <= 1;

  function setFusion(selected: string[], allocations: Record<string, number>) {
    update(p._id, { fusion_portfolio: { enabled: true, selected_portfolios: selected, allocations } });
  }

  const selectedAlloc = Object.fromEntries(f.selected_portfolios.map((n) => [n, Number(f.allocations[n]) || 0]));

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Portfolios fusionnés</span>
        <span className={totalOk ? styles.allocOk : styles.allocBad}>
          Total {total.toFixed(1)} %{totalOk ? '' : ' (doit faire 100 %)'}
        </span>
      </div>
      <p className={styles.hint}>
        Chaque portfolio garde son propre rebalancement ; la fusion les rééquilibre entre eux selon la fréquence de rebalancement de la fusion ({FREQUENCY_LABELS[p.rebalancing_frequency] ?? p.rebalancing_frequency}).
      </p>
      <div className={styles.btnRow}>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const names = candidates.map((c) => c.name);
            setFusion(names, equalFusionAllocations(names));
          }}
          disabled={!candidates.length}
        >
          Tout sélectionner (poids égaux)
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!f.selected_portfolios.length}
          onClick={() => setFusion(f.selected_portfolios, equalFusionAllocations(f.selected_portfolios))}
        >
          Poids égaux
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!f.selected_portfolios.length || total <= 0}
          onClick={() => setFusion(f.selected_portfolios, normalizeWeights(selectedAlloc))}
        >
          Normaliser
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!f.selected_portfolios.length}
          title="Nom construit à partir des 2 plus gros poids, comme dans Streamlit"
          onClick={() => {
            rename(p._id, fusionName(selectedAlloc, p.rebalancing_frequency));
            commitName(p._id);
          }}
        >
          Nom automatique
        </button>
      </div>
      {!candidates.length && <p className={styles.sectionSub}>Ajoute d&apos;abord des portfolios normaux à fusionner.</p>}
      {candidates.map((c) => {
        const on = f.selected_portfolios.includes(c.name);
        return (
          <div key={c._id} className={styles.grid2} style={{ alignItems: 'center' }}>
            <Check
              checked={on}
              onChange={(v) => {
                const sel = v ? [...f.selected_portfolios, c.name] : f.selected_portfolios.filter((n) => n !== c.name);
                const alloc = { ...f.allocations };
                if (v && alloc[c.name] === undefined) alloc[c.name] = 0;
                if (!v) delete alloc[c.name];
                setFusion(sel, alloc);
              }}
            >
              {c.name}
            </Check>
            {on && (
              <NumInput
                value={Number(f.allocations[c.name]) || 0}
                min={0}
                max={100}
                step={5}
                scale={100}
                suffix="%"
                onChange={(v) => setFusion(f.selected_portfolios, { ...f.allocations, [c.name]: v })}
              />
            )}
          </div>
        );
      })}
    </section>
  );
}

function MomentumSection({ p, set }: { p: EditablePortfolio; set: SetFn }) {
  const windows = p.momentum_windows ?? [];
  const weightTotal = windows.reduce((s, w) => s + (Number(w.weight) || 0), 0);
  const setWin = (i: number, patch: Partial<MomentumWindow>) =>
    set({ momentum_windows: windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) });

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>
          <Toggle on={p.use_momentum} onChange={(v) => set({ use_momentum: v })} label="Activer le momentum" title={TIPS.momentum} />
          <span title={TIPS.momentum}>Momentum</span>
        </span>
        <span className={styles.sectionSub}>Les allocations deviennent dynamiques selon le momentum</span>
      </div>
      <div className={p.use_momentum ? undefined : styles.disabledBlock} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <div className={styles.grid2}>
          <SelectField label="Stratégie" value={p.momentum_strategy ?? 'Classic'} options={MOMENTUM_OPTIONS} title={TIPS.strategy} onChange={(v) => set({ momentum_strategy: v })} />
          <SelectField
            label="Si tout est négatif"
            value={p.negative_momentum_strategy ?? 'Cash'}
            options={NEGATIVE_OPTIONS}
            title={TIPS.negative}
            onChange={(v) => set({ negative_momentum_strategy: v })}
          />
        </div>

        <div className={styles.sectionHead}>
          <span className={styles.sectionSub}>
            Fenêtres (lookback / exclusion en jours) · poids total {(weightTotal * 100).toFixed(0)} %
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => set({ momentum_windows: [...windows, { lookback: 90, exclude: 10, weight: 0.1 }] })}
          >
            + Fenêtre
          </button>
        </div>
        {windows.map((w, i) => (
          <div key={i} className={styles.winRow}>
            <NumField label="Lookback" value={w.lookback} min={1} step={5} title={TIPS.lookback} onChange={(v) => setWin(i, { lookback: Math.round(v) })} />
            <NumField label="Exclusion" value={w.exclude} min={0} step={5} title={TIPS.exclude} onChange={(v) => setWin(i, { exclude: Math.round(v) })} />
            <NumField label="Poids" value={w.weight} scale={100} suffix="%" min={0} max={100} step={5} title={TIPS.windowWeight} onChange={(v) => setWin(i, { weight: v })} />
            <Check checked={Boolean(w.discard_if_negative)} onChange={(v) => setWin(i, { discard_if_negative: v })} title={TIPS.discardNegative}>Rejeter si négatif</Check>
            <Check checked={Boolean(w.discard_unless_recent_positive)} onChange={(v) => setWin(i, { discard_unless_recent_positive: v })} title={TIPS.requireRecentPositive}>
              Exiger récent positif
            </Check>
            <button
              type="button"
              className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
              onClick={() => set({ momentum_windows: windows.filter((_, j) => j !== i) })}
              title="Retirer"
            >
              ✕
            </button>
          </div>
        ))}

        <div className={styles.grid2}>
          <div className={styles.field}>
            <Check checked={Boolean(p.calc_beta)} onChange={(v) => set({ calc_beta: v })} title={TIPS.betaWeighting}>Pondération inverse au bêta</Check>
            {p.calc_beta && (
              <div className={styles.grid2}>
                <NumField label="Fenêtre bêta (j)" value={p.beta_window_days} min={1} title={TIPS.betaWindow} onChange={(v) => set({ beta_window_days: Math.round(v) })} />
                <NumField label="Exclusion (j)" value={p.exclude_days_beta} min={0} title={TIPS.riskExclude} onChange={(v) => set({ exclude_days_beta: Math.round(v) })} />
              </div>
            )}
          </div>
          <div className={styles.field}>
            <Check checked={Boolean(p.calc_volatility)} onChange={(v) => set({ calc_volatility: v })} title={TIPS.volWeighting}>Pondération inverse à la volatilité</Check>
            {p.calc_volatility && (
              <div className={styles.grid2}>
                <NumField label="Fenêtre vol (j)" value={p.vol_window_days} min={1} title={TIPS.volWindow} onChange={(v) => set({ vol_window_days: Math.round(v) })} />
                <NumField label="Exclusion (j)" value={p.exclude_days_vol} min={0} title={TIPS.riskExclude} onChange={(v) => set({ exclude_days_vol: Math.round(v) })} />
              </div>
            )}
          </div>
        </div>

        <div className={styles.grid2}>
          <div className={styles.field}>
            <Check checked={Boolean(p.use_minimal_threshold)} onChange={(v) => set({ use_minimal_threshold: v })} title={TIPS.minThreshold}>Seuil minimal d&apos;allocation</Check>
            {p.use_minimal_threshold && (
              <NumInput value={p.minimal_threshold_percent} suffix="%" min={0} max={100} step={0.5} onChange={(v) => set({ minimal_threshold_percent: v })} />
            )}
          </div>
          <div className={styles.field}>
            <Check checked={Boolean(p.use_max_allocation)} onChange={(v) => set({ use_max_allocation: v })} title={TIPS.maxAllocation}>Allocation maximale par actif</Check>
            {p.use_max_allocation && (
              <NumInput value={p.max_allocation_percent} suffix="%" min={0} max={100} step={1} onChange={(v) => set({ max_allocation_percent: v })} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function MaSection({ p, set }: { p: EditablePortfolio; set: SetFn }) {
  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>
          <Toggle on={Boolean(p.use_sma_filter)} onChange={(v) => set({ use_sma_filter: v })} label="Activer le filtre MA" title={TIPS.ma} />
          <span title={TIPS.ma}>Filtre moyenne mobile</span>
        </span>
        <span className={styles.sectionSub}>Exclut les actifs sous leur moyenne mobile</span>
      </div>
      <div className={p.use_sma_filter ? undefined : styles.disabledBlock} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <div className={styles.grid2}>
          <SelectField
            label="Type"
            value={p.ma_type ?? 'SMA'}
            options={[{ value: 'SMA', label: 'SMA (simple)' }, { value: 'EMA', label: 'EMA (exponentielle)' }]}
            title={TIPS.maType}
            onChange={(v) => set({ ma_type: v })}
          />
          <NumField label="Fenêtre (jours)" value={p.sma_window} min={2} step={10} title={TIPS.maWindow} onChange={(v) => set({ sma_window: Math.round(v) })} />
          <NumField
            label={`Multiplicateur ${p.ma_type === 'EMA' ? 'EMA' : 'SMA'}`}
            value={(p.ma_multiplier as number | undefined) ?? 1.48}
            step={0.01}
            min={0}
            title={TIPS.maMultiplier}
            onChange={(v) => set({ ma_multiplier: v })}
          />
        </div>
        <div className={styles.grid2}>
          <Check checked={Boolean(p.use_global_ma_reference)} onChange={(v) => set({ use_global_ma_reference: v })} title={TIPS.maGlobalRef}>
            Référence MA commune
          </Check>
          {p.use_global_ma_reference && (
            <TextField
              label="Ticker de référence"
              value={p.global_ma_reference_ticker ?? ''}
              mono
              title={TIPS.maGlobalRef}
              onChange={(v) => set({ global_ma_reference_ticker: v.toUpperCase().replace(/,/g, '.') })}
            />
          )}
        </div>
        <div className={styles.grid2}>
          <Check checked={Boolean(p.ma_cross_rebalance)} onChange={(v) => set({ ma_cross_rebalance: v })} title={TIPS.maCross}>
            Rebalancer au croisement de la MA
          </Check>
          {p.ma_cross_rebalance && (
            <>
              <NumField label="Tolérance" value={p.ma_tolerance_percent} suffix="%" step={0.5} min={0} title={TIPS.maTolerance} onChange={(v) => set({ ma_tolerance_percent: v })} />
              <NumField label="Jours de confirmation" value={p.ma_confirmation_days} min={0} title={TIPS.maConfirmation} onChange={(v) => set({ ma_confirmation_days: Math.round(v) })} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function SectorIndustryInfo() {
  return (
    <InfoTip label="Secteur ou industrie ?">
      <p><strong>Secteur</strong> : grande famille d’activité, une douzaine chez Yahoo (Technology, Healthcare, Financial Services, Energy…).</p>
      <p><strong>Industrie</strong> : sous-catégorie plus fine d’un secteur, environ 150 (Semiconductors, Software – Infrastructure, Banks – Regional…).</p>
      <p>
        Exemple : NVDA et MSFT sont dans le même secteur (Technology) mais pas la même industrie (Semiconductors vs Software – Infrastructure).
        « Max 2 par secteur » limite toute la tech à 2 titres ; « Max 2 par industrie » permet 2 semi-conducteurs et 2 logiciels.
      </p>
      <p>
        Les titres sont pris dans l’ordre du classement ; ceux qui dépassent la limite sont mis de côté. Avec « N meilleurs » ou « Poids égaux »,
        ils reviennent seulement s’il manque des titres pour atteindre N.
      </p>
    </InfoTip>
  );
}

function AdvancedSection({ p, set }: { p: EditablePortfolio; set: SetFn }) {
  const b = (k: string) => Boolean(p[k]);
  const n = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>Options avancées (univers, secteurs, capitalisation)</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <Check checked={b('use_equal_weight')} onChange={(v) => set({ use_equal_weight: v })} title={TIPS.equalWeight}>Poids égaux sur les N meilleurs</Check>
            {b('use_equal_weight') && <NumInput value={n('equal_weight_n_tickers')} min={1} title="Nombre de titres gardés" onChange={(v) => set({ equal_weight_n_tickers: Math.round(v) })} />}
          </div>
          <div className={styles.field}>
            <Check checked={b('use_limit_to_top_n')} onChange={(v) => set({ use_limit_to_top_n: v })} title={TIPS.limitTopN}>Limiter aux N meilleurs</Check>
            {b('use_limit_to_top_n') && <NumInput value={n('limit_to_top_n_tickers')} min={1} title="Nombre de titres gardés" onChange={(v) => set({ limit_to_top_n_tickers: Math.round(v) })} />}
          </div>
        </div>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <span className={styles.labelWithInfo}>
              <Check checked={b('use_sector_concentration_limit')} onChange={(v) => set({ use_sector_concentration_limit: v })} title={TIPS.sectorCap}>
                Max tickers par secteur
              </Check>
              <SectorIndustryInfo />
            </span>
            {b('use_sector_concentration_limit') && <NumInput value={n('max_tickers_per_sector')} min={1} title="Titres maximum dans un même secteur" onChange={(v) => set({ max_tickers_per_sector: Math.round(v) })} />}
          </div>
          <div className={styles.field}>
            <Check checked={b('use_industry_concentration_limit')} onChange={(v) => set({ use_industry_concentration_limit: v })} title={TIPS.industryCap}>
              Max tickers par industrie
            </Check>
            {b('use_industry_concentration_limit') && <NumInput value={n('max_tickers_per_industry')} min={1} title="Titres maximum dans une même industrie" onChange={(v) => set({ max_tickers_per_industry: Math.round(v) })} />}
          </div>
        </div>
        <div className={styles.grid2}>
          <div className={styles.field}>
            <Check checked={b('use_min_market_cap_filter')} onChange={(v) => set({ use_min_market_cap_filter: v })} title={TIPS.minCap}>Capitalisation minimale (G$)</Check>
            {b('use_min_market_cap_filter') && <NumInput value={n('min_market_cap_billions') ?? 10} min={0} step={1} suffix="G$" title="Seuil en milliards de dollars" onChange={(v) => set({ min_market_cap_billions: v })} />}
          </div>
          <Check checked={b('exclude_before_sp500_entry')} onChange={(v) => set({ exclude_before_sp500_entry: v })} title={TIPS.sp500Entry}>
            Exclure avant l&apos;entrée dans le S&amp;P 500
          </Check>
          <Check
            checked={p.unknown_counts_as_category === undefined ? true : b('unknown_counts_as_category')}
            onChange={(v) => set({ unknown_counts_as_category: v })}
            title={TIPS.unknownCategory}
          >
            Secteur / industrie inconnu = une catégorie
          </Check>
        </div>
      </div>
    </section>
  );
}
