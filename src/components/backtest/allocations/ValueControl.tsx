'use client';

import { useCallback, useEffect, useState } from 'react';
import { readMyValue, VALUES_EVENT, writeMyValue } from '@/lib/backtest/cloud-sync';
import type { AllocationTable, FundamentalsReport } from '@/lib/engine/types';
import { money } from '../results/format';
import styles from './Allocations.module.css';

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CHF'] as const;

/** Real portfolio value typed by the user (per portfolio name, synced to the account); null = backtest value. */
export function useMyValue(name: string): [number | null, (v: number | null) => void] {
  const [value, setValue] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setValue(readMyValue(name));
    read();
    window.addEventListener(VALUES_EVENT, read);
    return () => window.removeEventListener(VALUES_EVENT, read);
  }, [name]);
  const update = useCallback((v: number | null) => {
    setValue(v);
    writeMyValue(name, v);
  }, [name]);
  return [value, update];
}

// Same rounding as the engine (allocations_api._row / Streamlit): shares to 0.1, value = shares × price.
function position(pv: number, allocPct: number, price: number | null) {
  const target = (pv * allocPct) / 100;
  const shares = price && price > 0 ? Math.round((target / price) * 10) / 10 : 0;
  const value = price && price > 0 ? shares * price : target;
  return { shares, value, pct: pv > 0 ? (value / pv) * 100 : 0 };
}

export function rescaleTable(table: AllocationTable | null, pv: number): AllocationTable | null {
  if (!table) return null;
  const rows = table.rows.map((r) => {
    const { shares, value, pct } = position(pv, r.alloc_pct, r.ticker === 'CASH' ? null : r.price);
    return { ...r, shares, value, pct };
  });
  const total = rows.reduce((s, r) => s + r.value, 0);
  return { ...table, rows, total: { ...table.total, value: total, pct: pv > 0 ? (total / pv) * 100 : 0 } };
}

export function rescaleReport(report: FundamentalsReport | null, pv: number): FundamentalsReport | null {
  if (!report) return null;
  const rows = report.rows.map((r) => {
    const alloc = Number(r.alloc_pct) || 0;
    const price = typeof r.price === 'number' ? r.price : null;
    const { shares, value, pct } = position(pv, alloc, price);
    return { ...r, shares, value, pct_of_portfolio: pct };
  });
  return { ...report, portfolio_value: pv, rows };
}

function CurrencyConverter({ onUse }: { onUse: (v: number) => void }) {
  const [from, setFrom] = useState<string>('CAD');
  const [to, setTo] = useState<string>('USD');
  const [amount, setAmount] = useState('');
  const [fx, setFx] = useState<{ rate: number; as_of: string } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    setFx(null);
    setError('');
    fetch(`/api/fx?from=${from}&to=${to}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'Taux indisponible');
        if (!stale) setFx({ rate: j.rate, as_of: j.as_of });
      })
      .catch((e: Error) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [from, to]);

  const n = Number(amount);
  const converted = fx && n > 0 ? n * fx.rate : null;
  return (
    <div className={styles.fxBox}>
      <div className={styles.fxRow}>
        <input className={`input ${styles.fxAmount}`} type="number" min={0} step={100} placeholder="Montant" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <select className={`input ${styles.fxCurrency}`} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Devise source">
          {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </select>
        <button type="button" className={styles.fxSwap} onClick={() => { setFrom(to); setTo(from); }} title="Inverser">⇄</button>
        <select className={`input ${styles.fxCurrency}`} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Devise cible">
          {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div className={styles.fxMeta}>
        {error ? <span className={styles.fxErr}>{error}</span>
          : fx ? <span>1 {from} = {fx.rate.toFixed(4)} {to} · {new Date(fx.as_of).toLocaleString('fr-CA', { dateStyle: 'short', timeStyle: 'short' })}</span>
            : <span>Chargement du taux…</span>}
        {converted !== null && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => onUse(Math.round(converted))}>
            Utiliser {converted.toLocaleString('fr-CA', { maximumFractionDigits: 0 })} {to}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ValueControl({ value, backtestValue, onChange }: { value: number | null; backtestValue: number | null; onChange: (v: number | null) => void }) {
  const [draft, setDraft] = useState('');
  const [showFx, setShowFx] = useState(false);
  useEffect(() => setDraft(value === null ? '' : String(value)), [value]);

  const commit = () => {
    const n = Number(draft);
    onChange(draft.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : null);
  };

  return (
    <div className={styles.valueCard}>
      <div className={styles.valueMain}>
        <label className={styles.valueLabel} htmlFor="alloc-my-value">Valeur de mon portefeuille</label>
        <div className={styles.valueInputRow}>
          <span className={styles.valueCurrency}>$</span>
          <input
            id="alloc-my-value"
            className={styles.valueInput}
            type="number"
            min={0}
            step={1000}
            placeholder={backtestValue ? String(Math.round(backtestValue)) : 'ex. 250000'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          {value !== null && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange(null)} title="Revenir à la valeur simulée par le backtest">
              Valeur du backtest
            </button>
          )}
          <button type="button" className={`btn btn-ghost btn-sm ${showFx ? styles.fxOn : ''}`} onClick={() => setShowFx((s) => !s)}>
            💱 Convertir
          </button>
        </div>
        <div className={styles.valueHint}>
          {value === null
            ? <>Actions calculées sur la valeur simulée du backtest ({money(backtestValue, 0)}). Saisis ta vraie valeur pour savoir combien d’actions détenir.</>
            : <>Actions calculées sur ta valeur, dans la devise de cotation de chaque titre. Mémorisée pour ce portfolio dans ton compte (tous tes appareils).</>}
        </div>
      </div>
      {showFx && <CurrencyConverter onUse={(v) => { onChange(v); setShowFx(false); }} />}
    </div>
  );
}
