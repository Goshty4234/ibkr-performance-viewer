'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EngineClient, QuoteInfo } from '@/lib/engine/client';
import EChart from './charts/EChart';
import { CHART_COLORS } from './charts/echarts-setup';
import styles from './Results.module.css';

export function bigMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} T$`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} G$`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)} M$`;
  return `${Math.round(v).toLocaleString('fr-CA')} $`;
}

type Fmt = 'money' | 'big' | 'num' | 'pct' | 'pct100' | 'int' | 'date' | 'text';
const KEY_FIELDS: { key: string; label: string; fmt: Fmt }[] = [
  { key: 'marketCap', label: 'Market cap', fmt: 'big' },
  { key: 'netAssets', label: 'Actifs nets (fonds)', fmt: 'big' },
  { key: 'trailingPE', label: 'PER (12 mois)', fmt: 'num' },
  { key: 'forwardPE', label: 'PER prévisionnel', fmt: 'num' },
  { key: 'epsTrailingTwelveMonths', label: 'BPA 12 mois', fmt: 'money' },
  { key: 'epsForward', label: 'BPA prévisionnel', fmt: 'money' },
  { key: 'priceToBook', label: 'Cours / valeur comptable', fmt: 'num' },
  { key: 'dividendYield', label: 'Rendement dividende', fmt: 'pct100' },
  { key: 'trailingAnnualDividendRate', label: 'Dividende 12 mois', fmt: 'money' },
  { key: 'sharesOutstanding', label: 'Actions en circulation', fmt: 'int' },
  { key: 'fiftyTwoWeekLow', label: 'Bas 52 sem.', fmt: 'money' },
  { key: 'fiftyTwoWeekHigh', label: 'Haut 52 sem.', fmt: 'money' },
  { key: 'averageDailyVolume3Month', label: 'Volume moyen 3 mois', fmt: 'int' },
  { key: 'netExpenseRatio', label: 'Frais (fonds)', fmt: 'pct100' },
  { key: 'averageAnalystRating', label: 'Avis analystes', fmt: 'text' },
  { key: 'earningsTimestamp', label: 'Résultats', fmt: 'date' },
];

function fmt(v: unknown, f: Fmt): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v !== 'number') return String(v);
  switch (f) {
    case 'big': return bigMoney(v);
    case 'money': return v.toLocaleString('fr-CA', { maximumFractionDigits: 2 });
    case 'num': return v.toFixed(2);
    case 'pct': return `${(v * 100).toFixed(2)} %`;
    case 'pct100': return `${v.toFixed(2)} %`;
    case 'int': return Math.round(v).toLocaleString('fr-CA');
    case 'date': return new Date(v * 1000).toISOString().slice(0, 10);
    default: return String(v);
  }
}

/** Yahoo quote of a ticker as archived by the engine: key figures, every raw field, and their history (one point per archived day). */
export default function TickerQuoteCard({ client, ticker, canRefresh }: { client: EngineClient; ticker: string; canRefresh: boolean }) {
  const [info, setInfo] = useState<QuoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [field, setField] = useState('marketCap');

  const load = useCallback(async (refresh: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await client.storeQuote(ticker, refresh));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [client, ticker]);

  useEffect(() => {
    setInfo(null);
    load(false);
  }, [load]);

  const latest = info?.latest ?? null;
  const hist = info?.history;
  const series = hist?.fields[field] ?? [];
  const points = series.filter((v) => v !== null).length;
  const option = useMemo(() => (hist && points >= 2
    ? {
        grid: { left: 70, right: 20, top: 20, bottom: 30 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'category', data: hist.dates },
        yAxis: { type: 'value', scale: true },
        series: [{ type: 'line', data: series, showSymbol: true, symbolSize: 4, lineStyle: { color: CHART_COLORS.accent } }],
      }
    : null), [hist, series, points]);

  const rawFields = useMemo(() => (latest ? Object.entries(latest).filter(([k]) => k !== '_day').sort(([a], [b]) => a.localeCompare(b)) : []), [latest]);

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Fiche {latest?.longName ? `· ${String(latest.longName)}` : ''}</div>
          <div className={styles.cardSub}>
            {latest
              ? `Fiche Yahoo archivée le ${latest._day} · ${[latest.quoteType, latest.fullExchangeName, latest.currency].filter(Boolean).join(' · ')}`
              : 'Aucune fiche archivée pour ce ticker'}
            {' '}· chaque mise à jour garde la fiche du jour : Yahoo ne donne pas l’historique du market cap ni du PER, on le construit.
          </div>
        </div>
        {canRefresh && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => load(true)} title="Demande la fiche du jour à Yahoo (1 requête)">
            {busy ? 'Chargement…' : 'Rafraîchir la fiche'}
          </button>
        )}
      </div>
      {error && <div className={styles.padded}>{error}</div>}
      {latest && (
        <>
          <div className={styles.kpis}>
            {KEY_FIELDS.filter((f) => latest[f.key] !== undefined && latest[f.key] !== null).map((f) => (
              <div key={f.key}><span>{f.label}</span><strong>{fmt(latest[f.key], f.fmt)}</strong></div>
            ))}
          </div>
          <div className={styles.padded}>
            <div className={styles.toolbarInline}>
              <span className={styles.cardSub}>Historique archivé ({hist?.dates.length ?? 0} jour{(hist?.dates.length ?? 0) > 1 ? 's' : ''}) :</span>
              <select className={styles.select} value={field} onChange={(e) => setField(e.target.value)}>
                {Object.keys(hist?.fields ?? {}).map((k) => <option key={k} value={k}>{KEY_FIELDS.find((f) => f.key === k)?.label ?? k}</option>)}
              </select>
            </div>
            {option ? <EChart option={option} height={200} /> : <p className={styles.cardSub}>Le graphique apparaît dès qu’il y a au moins deux jours archivés.</p>}
            <details>
              <summary className={styles.cardSub}>Tous les champs Yahoo ({rawFields.length})</summary>
              <table style={{ width: '100%', fontSize: '0.76rem', fontFamily: 'var(--mono)' }}>
                <tbody>
                  {rawFields.map(([k, v]) => (
                    <tr key={k}><td style={{ color: 'var(--text-muted)', paddingRight: '1rem' }}>{k}</td><td>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            </details>
          </div>
        </>
      )}
    </div>
  );
}
