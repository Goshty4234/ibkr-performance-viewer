'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  MOMENTUM_STRATEGIES,
  NEGATIVE_STRATEGIES,
  type EditablePortfolio,
} from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import {
  defaultVariantSpec,
  generateVariants,
  validateVariantSpec,
  variantCount,
  type ValueAxis,
  type VariantSpec,
  type WindowConfig,
} from '@/lib/backtest/variants';
import type { MomentumWindow } from '@/lib/engine/types';
import styles from './Backtester.module.css';

const toggleIn = <T,>(list: T[], v: T, on: boolean): T[] => (on ? (list.includes(v) ? list : [...list, v]) : list.filter((x) => x !== v));

function parseNums(text: string): number[] {
  return text
    .split(/[\s,;]+/)
    .map((t) => Number(t.replace(',', '.')))
    .filter((n) => Number.isFinite(n));
}

/** Text field committing on blur, so partial input ("1," / "365/3") is never parsed mid-typing. */
function LazyInput({ value, onCommit, placeholder, width }: { value: string; onCommit: (text: string) => void; placeholder?: string; width?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      type="text"
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      style={width ? { maxWidth: width } : undefined}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(text)}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
    />
  );
}

const windowsText = (ws: MomentumWindow[]) => ws.map((w) => `${w.lookback}/${w.exclude}/${Math.round(w.weight * 1000) / 10}`).join(', ');

function parseWindows(text: string): MomentumWindow[] {
  return text
    .split(/[,;]+/)
    .map((chunk) => chunk.trim().split(/[\s/]+/).map(Number))
    .filter((a) => a.length >= 3 && a.every(Number.isFinite))
    .map(([lookback, exclude, weight]) => ({
      lookback: Math.round(lookback),
      exclude: Math.round(exclude),
      weight: weight / 100,
      discard_if_negative: false,
      discard_unless_recent_positive: false,
    }));
}

function Checks<T extends string | boolean>({ options, value, onChange }: {
  options: readonly { value: T; label: string }[];
  value: T[];
  onChange: (v: T[]) => void;
}) {
  return (
    <>
      {options.map((o) => (
        <label key={String(o.value)} className={styles.checkRow}>
          <input type="checkbox" checked={value.includes(o.value)} onChange={(e) => onChange(toggleIn(value, o.value, e.target.checked))} />
          {o.label}
        </label>
      ))}
    </>
  );
}

function AxisValues({ axis, onChange, unit }: { axis: ValueAxis<number>; onChange: (a: ValueAxis<number>) => void; unit?: string }) {
  return (
    <>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={axis.off} onChange={(e) => onChange({ ...axis, off: e.target.checked })} />
        Désactivé
      </label>
      <label className={styles.checkRow}>
        <input type="checkbox" checked={axis.on} onChange={(e) => onChange({ ...axis, on: e.target.checked })} />
        Activé
      </label>
      {axis.on && (
        <>
          <LazyInput value={axis.values.join(', ')} onCommit={(t) => onChange({ ...axis, values: parseNums(t) })} placeholder="ex. 2, 5, 10" width={180} />
          {unit && <span className={styles.hint}>{unit}</span>}
        </>
      )}
    </>
  );
}

function WindowConfigs({ list, onChange, label }: { list: WindowConfig[]; onChange: (l: WindowConfig[]) => void; label: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', width: '100%' }}>
      {list.map((c, i) => (
        <div key={i} className={styles.btnRow}>
          <LazyInput
            value={`${c.lookback}/${c.exclude}`}
            width={110}
            placeholder="365/30"
            onCommit={(t) => {
              const [lb, ex] = t.split(/[\s/]+/).map(Number);
              if (Number.isFinite(lb) && Number.isFinite(ex)) onChange(list.map((x, j) => (j === i ? { ...x, lookback: Math.round(lb), exclude: Math.round(ex) } : x)));
            }}
          />
          <LazyInput value={c.tag} width={110} placeholder="tag (optionnel)" onCommit={(t) => onChange(list.map((x, j) => (j === i ? { ...x, tag: t.trim() } : x)))} />
          <button type="button" className={`${styles.iconBtn} ${styles.iconBtnDanger}`} disabled={list.length <= 1} onClick={() => onChange(list.filter((_, j) => j !== i))} title="Retirer">✕</button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...list, { lookback: 365, exclude: 30, tag: '' }])}>
        + {label}
      </button>
    </div>
  );
}

const FREQ_OPTS = FREQUENCIES.map((f) => ({ value: f as string, label: FREQUENCY_LABELS[f] }));
const MOM_OPTS = MOMENTUM_STRATEGIES.map((m) => ({ value: m as string, label: m === 'Classic' ? 'Classique' : m === 'Relative Momentum' ? 'Relatif' : 'NZS' }));
const NEG_OPTS = NEGATIVE_STRATEGIES.map((m) => ({
  value: m as string,
  label: m === 'Cash' ? 'Cash' : m === 'Equal weight' ? 'Poids égaux' : m === 'Relative momentum' ? 'Relatif' : 'NZS',
}));
const BOOL_OPTS = [{ value: true, label: 'Avec' }, { value: false, label: 'Sans' }] as const;

/** Streamlit "Generate Portfolio Variants": cartesian product of the chosen options, named like Streamlit. */
export default function VariantGenerator({ p }: { p: EditablePortfolio }) {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const addVariants = useBacktestStore((s) => s.addVariants);
  const [spec, setSpec] = useState<VariantSpec>(defaultVariantSpec);
  const [notice, setNotice] = useState<string | null>(null);
  const patch = (x: Partial<VariantSpec>) => setSpec((s) => ({ ...s, ...x }));

  const count = useMemo(() => variantCount(spec), [spec]);
  const errors = useMemo(() => validateVariantSpec(spec), [spec]);

  function generate() {
    if (errors.length) return;
    if (count > 500 && !confirm(`Générer ${count} variantes ? Le backtest sera long.`)) return;
    const taken = portfolios.filter((x) => spec.keepCurrent || x._id !== p._id).map((x) => x.name);
    const variants = generateVariants(p, spec, taken);
    addVariants(p._id, variants, spec.keepCurrent);
    setNotice(`${variants.length} variantes créées${spec.keepCurrent ? '' : ` (« ${p.name} » remplacé)`}.`);
    setTimeout(() => setNotice(null), 5000);
  }

  const anyMa = spec.sma.on || spec.ema.on;

  return (
    <section className={`card ${styles.section}`}>
      <details className={styles.details} style={{ border: 'none', background: 'none' }}>
        <summary style={{ padding: 0 }}>
          <span className={styles.sectionTitle}>Générer des variantes</span>
          <span className={styles.sectionSub}>Toutes les combinaisons des options cochées, à partir de ce portfolio</span>
        </summary>
        <div className={styles.detailsBody} style={{ padding: '0.75rem 0 0' }}>
          <div className={styles.axisRow}>
            <span className={styles.axisLabel}>Rebalancement</span>
            <div className={styles.axisBody}>
              <Checks options={FREQ_OPTS} value={spec.rebalance} onChange={(v) => patch({ rebalance: v })} />
            </div>
          </div>

          <div className={styles.axisRow}>
            <span className={styles.axisLabel}>Momentum</span>
            <div className={styles.axisBody}>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={spec.useMomentum} onChange={(e) => patch({ useMomentum: e.target.checked })} />
                Utiliser le momentum
              </label>
            </div>
          </div>

          {spec.useMomentum && (
            <>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Stratégie</span>
                <div className={styles.axisBody}><Checks options={MOM_OPTS} value={spec.momentumStrategies} onChange={(v) => patch({ momentumStrategies: v })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Si tout est négatif</span>
                <div className={styles.axisBody}><Checks options={NEG_OPTS} value={spec.negativeStrategies} onChange={(v) => patch({ negativeStrategies: v })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Bêta</span>
                <div className={styles.axisBody}><Checks options={BOOL_OPTS} value={spec.beta} onChange={(v) => patch({ beta: v })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Volatilité</span>
                <div className={styles.axisBody}><Checks options={BOOL_OPTS} value={spec.volatility} onChange={(v) => patch({ volatility: v })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Seuil minimal</span>
                <div className={styles.axisBody}><AxisValues axis={spec.threshold} unit="%" onChange={(a) => patch({ threshold: a })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Allocation max</span>
                <div className={styles.axisBody}><AxisValues axis={spec.maxAllocation} unit="%" onChange={(a) => patch({ maxAllocation: a })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Poids égaux (N)</span>
                <div className={styles.axisBody}><AxisValues axis={spec.equalWeight} unit="tickers" onChange={(a) => patch({ equalWeight: a })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Limiter aux N</span>
                <div className={styles.axisBody}><AxisValues axis={spec.limitTopN} unit="tickers" onChange={(a) => patch({ limitTopN: a })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Fenêtres momentum</span>
                <div className={styles.axisBody} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <span className={styles.hint}>Format « lookback/exclusion/poids% » séparés par des virgules. Une ligne = une configuration testée.</span>
                  {spec.momentumConfigs.map((c, i) => (
                    <div key={i} className={styles.btnRow}>
                      <LazyInput
                        value={windowsText(c.windows)}
                        width={300}
                        onCommit={(t) => {
                          const ws = parseWindows(t);
                          if (ws.length) patch({ momentumConfigs: spec.momentumConfigs.map((x, j) => (j === i ? { ...x, windows: ws } : x)) });
                        }}
                      />
                      <LazyInput value={c.tag} width={110} placeholder="tag (optionnel)" onCommit={(t) => patch({ momentumConfigs: spec.momentumConfigs.map((x, j) => (j === i ? { ...x, tag: t.trim() } : x)) })} />
                      <span className={styles.hint}>Σ {Math.round(c.windows.reduce((a, w) => a + w.weight, 0) * 100)} %</span>
                      <button
                        type="button"
                        className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                        disabled={spec.momentumConfigs.length <= 1}
                        onClick={() => patch({ momentumConfigs: spec.momentumConfigs.filter((_, j) => j !== i) })}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <div className={styles.btnRow}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => patch({ momentumConfigs: [...spec.momentumConfigs, { windows: defaultVariantSpec().momentumConfigs[0].windows, tag: '' }] })}
                    >
                      + Configuration
                    </button>
                    {(p.momentum_windows?.length ?? 0) > 0 && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => patch({ momentumConfigs: [...spec.momentumConfigs, { windows: (p.momentum_windows ?? []).map((w) => ({ ...w })), tag: '' }] })}
                      >
                        + Fenêtres du portfolio
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Fenêtres bêta</span>
                <div className={styles.axisBody}><WindowConfigs list={spec.betaConfigs} label="Bêta" onChange={(l) => patch({ betaConfigs: l })} /></div>
              </div>
              <div className={styles.axisRow}>
                <span className={styles.axisLabel}>Fenêtres volatilité</span>
                <div className={styles.axisBody}><WindowConfigs list={spec.volatilityConfigs} label="Volatilité" onChange={(l) => patch({ volatilityConfigs: l })} /></div>
              </div>
            </>
          )}

          <div className={styles.axisRow}>
            <span className={styles.axisLabel}>Filtre MA</span>
            <div className={styles.axisBody}>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={spec.maDisabled} onChange={(e) => patch({ maDisabled: e.target.checked })} />
                Sans MA
              </label>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={spec.sma.on} onChange={(e) => patch({ sma: { ...spec.sma, on: e.target.checked } })} />
                SMA
              </label>
              {spec.sma.on && <LazyInput value={spec.sma.values.join(', ')} width={140} onCommit={(t) => patch({ sma: { ...spec.sma, values: parseNums(t).map(Math.round) } })} />}
              <label className={styles.checkRow}>
                <input type="checkbox" checked={spec.ema.on} onChange={(e) => patch({ ema: { ...spec.ema, on: e.target.checked } })} />
                EMA
              </label>
              {spec.ema.on && <LazyInput value={spec.ema.values.join(', ')} width={140} onCommit={(t) => patch({ ema: { ...spec.ema, values: parseNums(t).map(Math.round) } })} />}
            </div>
          </div>

          {anyMa && (
            <div className={styles.axisRow}>
              <span className={styles.axisLabel}>Croisement MA</span>
              <div className={styles.axisBody}>
                <label className={styles.checkRow}>
                  <input type="checkbox" checked={spec.maCross.off} onChange={(e) => patch({ maCross: { ...spec.maCross, off: e.target.checked } })} />
                  Désactivé
                </label>
                <label className={styles.checkRow}>
                  <input type="checkbox" checked={spec.maCross.on} onChange={(e) => patch({ maCross: { ...spec.maCross, on: e.target.checked } })} />
                  Activé
                </label>
                {spec.maCross.on && (
                  <>
                    <span className={styles.hint}>Tolérance %</span>
                    <LazyInput value={spec.maCross.tolerances.join(', ')} width={110} onCommit={(t) => patch({ maCross: { ...spec.maCross, tolerances: parseNums(t) } })} />
                    <span className={styles.hint}>Jours</span>
                    <LazyInput value={spec.maCross.delays.join(', ')} width={110} onCommit={(t) => patch({ maCross: { ...spec.maCross, delays: parseNums(t).map(Math.round) } })} />
                  </>
                )}
              </div>
            </div>
          )}

          <div className={styles.axisRow}>
            <span className={styles.axisLabel}>Portfolio de base</span>
            <div className={styles.axisBody}>
              <label className={styles.checkRow}>
                <input type="checkbox" checked={spec.keepCurrent} onChange={(e) => patch({ keepCurrent: e.target.checked })} />
                Garder « {p.name} » en plus des variantes
              </label>
            </div>
          </div>

          {errors.length > 0 && <div className={styles.errorBox}>{errors.join('\n')}</div>}
          {notice && <div className={styles.notice}>{notice}</div>}
          <div className={styles.btnRow}>
            <span className={styles.variantCount}>{errors.length ? '—' : count}</span>
            <span className={styles.hint}>variante{count > 1 ? 's' : ''} à créer</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={errors.length > 0 || count === 0} onClick={generate}>
              Générer
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSpec(defaultVariantSpec())}>Réinitialiser</button>
          </div>
        </div>
      </details>
    </section>
  );
}
