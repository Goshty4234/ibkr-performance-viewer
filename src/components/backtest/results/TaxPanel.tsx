'use client';

import { useMemo, useState } from 'react';
import type { AcbTax, AcbYear, StreamlitGains, TradeKind } from '@/lib/engine/types';
import DataGrid, { type GridColumn } from '../grid/DataGrid';
import { money, pct, qty, signColor } from './format';
import styles from '../Results.module.css';

const KIND_LABEL: Record<TradeKind, string> = { buy: 'Achat', sell: 'Vente', drip: 'Réinvest. div.' };

type TxRow = { k: number };

function StreamlitGainsSection({ gains }: { gains: StreamlitGains }) {
  const [view, setView] = useState<'annual' | 'periods'>('annual');
  const annualCols = useMemo<GridColumn<StreamlitGains['annual'][number]>[]>(() => [
    { key: 'period', label: 'Année fiscale', width: 120, value: (r) => r.period },
    { key: 'realized', label: 'Gains réalisés', width: 150, align: 'right', value: (r) => r.realized, format: (v) => money(v as number), cellStyle: (v) => signColor(v as number) },
    { key: 'unrealized', label: 'Gains non réalisés', width: 160, align: 'right', value: (r) => r.unrealized, format: (v) => money(v as number), cellStyle: (v) => signColor(v as number) },
    { key: 'total', label: 'Total', width: 140, align: 'right', value: (r) => r.total, format: (v) => money(v as number), cellStyle: (v) => signColor(v as number) },
    { key: 'taxable_pct', label: '% imposable', width: 120, align: 'right', value: (r) => r.taxable_pct, format: (v) => pct(v as number) },
  ], []);

  type PRow = { k: number };
  const periodRows = useMemo<PRow[]>(() => gains.periods.map((_p, k) => ({ k })), [gains]);
  const periodCols = useMemo<GridColumn<PRow>[]>(() => [
    { key: 'period', label: 'Période', width: 200, value: (r) => gains.periods[r.k] },
    { key: 'rt', label: 'Réalisé (total)', width: 140, align: 'right', value: (r) => gains.realized_total[r.k], format: (v) => money(v as number), cellStyle: (v) => signColor(v as number) },
    { key: 'ut', label: 'Non réalisé (total)', width: 150, align: 'right', value: (r) => gains.unrealized_total[r.k], format: (v) => money(v as number), cellStyle: (v) => signColor(v as number) },
  ], [gains]);

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Gains réalisés / non réalisés (méthode Streamlit)</div>
          <div className={styles.cardSub}>Évaluation période par période à la valeur de marché, identique au site original</div>
        </div>
        <div className={styles.segment}>
          <button type="button" className={view === 'annual' ? styles.segOn : ''} onClick={() => setView('annual')}>Annuel</button>
          <button type="button" className={view === 'periods' ? styles.segOn : ''} onClick={() => setView('periods')}>Par période</button>
        </div>
      </div>
      <div className={styles.padded}>
        {view === 'annual' ? (
          <DataGrid columns={annualCols} rows={gains.annual} rowKey={(r) => r.period} csvName="gains-annuels-streamlit" />
        ) : (
          <DataGrid columns={periodCols} rows={periodRows} rowKey={(r) => r.k} csvName="gains-periodes-streamlit" />
        )}
      </div>
    </div>
  );
}

function AcbSection({ tax }: { tax: AcbTax }) {
  const [inclusion, setInclusion] = useState(50);
  const [marginal, setMarginal] = useState(0);
  const [txTicker, setTxTicker] = useState('');
  const [txKind, setTxKind] = useState<'' | TradeKind>('');
  const tx = tax.transactions;

  const yearCols = useMemo<GridColumn<AcbYear>[]>(() => {
    const m = (key: keyof AcbYear, label: string, width = 140, colored = false): GridColumn<AcbYear> => ({
      key, label, width, align: 'right', value: (r) => r[key] as number, format: (v) => money(v as number),
      cellStyle: colored ? (v) => signColor(v as number) : undefined,
    });
    const cols: GridColumn<AcbYear>[] = [
      { key: 'year', label: 'Année', width: 80, value: (r) => r.year },
      m('contributions', 'Apports'),
      m('buys', 'Achats'),
      m('sells', 'Ventes'),
      m('proceeds', 'Produit de disposition', 180),
      m('cost_base', 'PBR des titres vendus', 180),
      m('realized', 'Gain/perte en capital', 170, true),
      {
        key: 'taxable', label: `Gain imposable (${inclusion} %)`, width: 180, align: 'right',
        value: (r) => r.realized * (inclusion / 100), format: (v) => money(v as number), cellStyle: (v) => signColor(v as number),
      },
      m('dividends', 'Dividendes', 130),
      { key: 'trades', label: 'Transactions', width: 110, align: 'right', value: (r) => r.trades },
      m('market_value_end', 'Valeur marchande fin', 170),
      m('acb_end', 'PBR total fin', 150),
      m('unrealized_end', 'Plus-value latente fin', 170, true),
    ];
    if (marginal > 0) {
      cols.push({
        key: 'tax', label: `Impôt estimé (${marginal} %)`, width: 170, align: 'right',
        value: (r) => Math.max(0, r.realized * (inclusion / 100) * (marginal / 100)), format: (v) => money(v as number),
      });
    }
    return cols;
  }, [inclusion, marginal]);

  const totals = useMemo(() => {
    const realized = tax.years.reduce((a, y) => a + y.realized, 0);
    const dividends = tax.years.reduce((a, y) => a + y.dividends, 0);
    const last = tax.years[tax.years.length - 1];
    return { realized, dividends, unrealized: last?.unrealized_end ?? 0, acb: last?.acb_end ?? 0, mv: last?.market_value_end ?? 0 };
  }, [tax]);

  const txRows = useMemo<TxRow[]>(() => {
    if (!tx) return [];
    const tIdx = txTicker ? tx.tickers.indexOf(txTicker) : -1;
    const out: TxRow[] = [];
    for (let k = 0; k < tx.kind.length; k++) {
      if (txTicker && tx.ticker_idx[k] !== tIdx) continue;
      if (txKind && tx.kind[k] !== txKind) continue;
      out.push({ k });
    }
    return out;
  }, [tx, txTicker, txKind]);

  const txCols = useMemo<GridColumn<TxRow>[]>(() => {
    if (!tx) return [];
    return [
      { key: 'date', label: 'Date', width: 104, value: (r) => tx.dates[tx.date_idx[r.k]] },
      { key: 'ticker', label: 'Ticker', width: 90, value: (r) => tx.tickers[tx.ticker_idx[r.k]] },
      { key: 'kind', label: 'Type', width: 120, value: (r) => KIND_LABEL[tx.kind[r.k]] ?? tx.kind[r.k] },
      { key: 'qty', label: 'Quantité', width: 110, align: 'right', value: (r) => tx.qty[r.k], format: (v) => qty(v as number) },
      { key: 'price', label: 'Prix', width: 100, align: 'right', value: (r) => tx.price[r.k], format: (v) => money(v as number) },
      { key: 'amount', label: 'Montant', width: 120, align: 'right', value: (r) => tx.amount[r.k], format: (v) => money(v as number) },
      { key: 'gain', label: 'Gain réalisé', width: 120, align: 'right', value: (r) => tx.gain[r.k], format: (v) => (v === null ? '' : money(v as number)), cellStyle: (v) => signColor(v as number) },
      { key: 'shares', label: 'Détenu après', width: 120, align: 'right', value: (r) => tx.shares_after[r.k], format: (v) => qty(v as number) },
      { key: 'acbps', label: 'PBR / action', width: 110, align: 'right', value: (r) => tx.acb_per_share[r.k], format: (v) => money(v as number, 4) },
    ];
  }, [tx]);

  const posCols = useMemo<GridColumn<AcbTax['positions'][number]>[]>(() => [
    { key: 'ticker', label: 'Ticker', width: 100, value: (r) => r.ticker },
    { key: 'shares', label: 'Actions', width: 120, align: 'right', value: (r) => r.shares, format: (v) => qty(v as number) },
    { key: 'acb', label: 'PBR total', width: 140, align: 'right', value: (r) => r.acb, format: (v) => money(v as number) },
    { key: 'acbps', label: 'PBR / action', width: 120, align: 'right', value: (r) => r.acb_per_share, format: (v) => money(v as number, 4) },
    { key: 'price', label: 'Prix', width: 110, align: 'right', value: (r) => r.price, format: (v) => money(v as number) },
    { key: 'mv', label: 'Valeur marchande', width: 150, align: 'right', value: (r) => r.market_value, format: (v) => money(v as number) },
    { key: 'unrealized', label: 'Plus-value latente', width: 150, align: 'right', value: (r) => r.unrealized, format: (v) => money(v as number), cellStyle: (v) => signColor(v as number) },
  ], []);

  type BRow = { t: number };
  const by = tax.by_ticker;
  const byRows = useMemo<BRow[]>(() => (by ? by.tickers.map((_t, t) => ({ t })) : []), [by]);
  const byCols = useMemo<GridColumn<BRow>[]>(() => {
    if (!by) return [];
    return [
      { key: 'ticker', label: 'Ticker', width: 100, value: (r) => by.tickers[r.t] },
      {
        key: 'total', label: 'Total réalisé', width: 140, align: 'right',
        value: (r) => by.realized.reduce((a, row) => a + (row[r.t] ?? 0), 0), format: (v) => money(v as number), cellStyle: (v) => signColor(v as number),
      },
      ...by.years.map<GridColumn<BRow>>((y, yi) => ({
        key: `y${y}`, label: String(y), width: 110, align: 'right',
        value: (r) => by.realized[yi]?.[r.t] ?? null, format: (v) => (v ? money(v as number, 0) : ''), cellStyle: (v) => signColor(v as number),
      })),
    ];
  }, [by]);

  return (
    <div className="card">
      <div className={styles.cardHead}>
        <div>
          <div className={styles.cardTitle}>Fiscalité canadienne — prix de base rajusté (PBR)</div>
          <div className={styles.cardSub}>
            Coût moyen par titre, chaque achat / vente / réinvestissement suivi quotidiennement
            {tax.dividends_reinvested === false ? ' · dividendes encaissés en cash' : ' · dividendes réinvestis (augmentent le PBR)'}
          </div>
        </div>
        <div className={styles.toolbarInline}>
          <label className={styles.inlineField}>
            Taux d&apos;inclusion
            <input type="number" className="input" style={{ width: 80 }} min={0} max={100} step={0.01} value={inclusion} onChange={(e) => setInclusion(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
            %
          </label>
          <label className={styles.inlineField}>
            Taux marginal
            <input type="number" className="input" style={{ width: 80 }} min={0} max={100} step={0.01} value={marginal} onChange={(e) => setMarginal(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
            %
          </label>
        </div>
      </div>
      <div className={styles.kpis}>
        <div><span>Gains réalisés cumulés</span><strong style={signColor(totals.realized)}>{money(totals.realized)}</strong></div>
        <div><span>Imposable ({inclusion} %)</span><strong>{money(totals.realized * inclusion / 100)}</strong></div>
        <div><span>Dividendes cumulés</span><strong>{money(totals.dividends)}</strong></div>
        <div><span>Valeur marchande</span><strong>{money(totals.mv)}</strong></div>
        <div><span>PBR total</span><strong>{money(totals.acb)}</strong></div>
        <div><span>Plus-value latente</span><strong style={signColor(totals.unrealized)}>{money(totals.unrealized)}</strong></div>
      </div>
      <div className={styles.padded}>
        <div className={styles.subTitle}>Sommaire annuel</div>
        <DataGrid columns={yearCols} rows={tax.years} rowKey={(r) => r.year} csvName="pbr-annuel" maxHeight={420} />
      </div>
      {tax.positions.length > 0 && (
        <div className={styles.padded}>
          <div className={styles.subTitle}>Positions finales</div>
          <DataGrid columns={posCols} rows={tax.positions} rowKey={(r) => r.ticker} csvName="pbr-positions" maxHeight={360} />
        </div>
      )}
      {byRows.length > 0 && (
        <div className={styles.padded}>
          <div className={styles.subTitle}>Gains réalisés par titre et par année</div>
          <DataGrid columns={byCols} rows={byRows} rowKey={(r) => r.t} csvName="pbr-par-titre" maxHeight={360} initialSort={{ key: 'total', dir: 'desc' }} />
        </div>
      )}
      {tx && (
        <div className={styles.padded}>
          <DataGrid
            columns={txCols}
            rows={txRows}
            rowKey={(r) => r.k}
            maxHeight={520}
            csvName="pbr-transactions"
            toolbar={
              <>
                <span className={styles.subTitle} style={{ margin: 0 }}>
                  Transactions ({txRows.length.toLocaleString('fr-CA')}{tx.truncated ? ` sur ${tx.total.toLocaleString('fr-CA')}, tronqué` : ''})
                </span>
                <select className={styles.select} value={txTicker} onChange={(e) => setTxTicker(e.target.value)}>
                  <option value="">Tous les titres</option>
                  {tx.tickers.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <select className={styles.select} value={txKind} onChange={(e) => setTxKind(e.target.value as '' | TradeKind)}>
                  <option value="">Tous les types</option>
                  <option value="buy">Achats</option>
                  <option value="sell">Ventes</option>
                  <option value="drip">Réinvestissements</option>
                </select>
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

export default function TaxPanel({ gains, tax }: { gains?: StreamlitGains; tax?: AcbTax | null }) {
  return (
    <>
      {gains && gains.periods.length > 0 && <StreamlitGainsSection gains={gains} />}
      {tax && tax.years.length > 0 && <AcbSection tax={tax} />}
    </>
  );
}
