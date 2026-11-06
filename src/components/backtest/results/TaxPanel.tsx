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

function frDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short', year: 'numeric' });
}

function AcbSection({ tax }: { tax: AcbTax }) {
  const [inclusion, setInclusion] = useState(50);
  const [marginal, setMarginal] = useState(53);
  const [txTicker, setTxTicker] = useState('');
  const [txKind, setTxKind] = useState<'' | TradeKind>('');
  const tx = tax.transactions;
  const asOf = tax.as_of?.slice(0, 10) ?? null;
  const lastYear = tax.years[tax.years.length - 1]?.year ?? null;
  const lastYearPartial = Boolean(asOf && lastYear != null && Number(asOf.slice(0, 4)) === lastYear && asOf.slice(5, 7) !== '12');

  const yearCols = useMemo<GridColumn<AcbYear>[]>(() => {
    const m = (key: keyof AcbYear, label: string, width = 140, colored = false, title?: string): GridColumn<AcbYear> => ({
      key, label, width, title, align: 'right', value: (r) => r[key] as number, format: (v) => money(v as number),
      cellStyle: colored ? (v) => signColor(v as number) : undefined,
    });
    return [
      {
        key: 'year', label: 'Année', width: 110, value: (r) => r.year,
        format: (_v, r) => (lastYearPartial && r.year === lastYear && asOf ? `${r.year} · au ${frDay(asOf)}` : String(r.year)),
      },
      m('contributions', 'Apports', 140, false, 'Cash ajouté au portefeuille cette année (dépôt initial ou cotisations).'),
      m('buys', 'Achats', 140, false, 'Montant total des achats (et réinvestissements de dividendes) reconstruits cette année.'),
      m('sells', 'Ventes', 140, false, 'Montant total des ventes reconstruites cette année. Un momentum qui tourne beaucoup peut dépasser la valeur du portefeuille.'),
      m('proceeds', 'Produit de disposition', 180, false, 'Cash reçu en vendant (en pratique égal aux ventes).'),
      m('cost_base', 'PBR des titres vendus', 180, false, 'Prix de base rajusté (coût moyen) des actions vendues.'),
      m('realized', 'Gain/perte en capital', 170, true, 'Produit − PBR des titres vendus. Positif = gain réalisé.'),
      {
        key: 'taxable', label: `Gain imposable (${inclusion} %)`, width: 180, align: 'right',
        title: 'Au Canada, seule une partie du gain en capital entre dans le revenu imposable (taux d’inclusion, souvent 50 %).',
        value: (r) => r.realized * (inclusion / 100), format: (v) => money(v as number), cellStyle: (v) => signColor(v as number),
      },
      m('dividends', 'Dividendes', 130, false, 'Dividendes encaissés sur les titres détenus (séparés du gain en capital).'),
      { key: 'trades', label: 'Transactions', width: 110, align: 'right', value: (r) => r.trades, title: 'Nombre d’achats, ventes et réinvestissements reconstruits.' },
      m('market_value_end', 'Valeur marchande fin', 170, false, 'Valeur des titres encore détenus à la fin de l’année (ou à la fin de la simulation).'),
      m('acb_end', 'PBR total fin', 150, false, 'Coût fiscal total encore en inventaire. Peut dépasser la valeur marchande après avoir vendu des gagnants.'),
      m('unrealized_end', 'Plus-value latente fin', 170, true, 'Valeur marchande − PBR des titres encore détenus. Ce n’est pas un gain imposable tant qu’on ne vend pas.'),
      {
        key: 'tax', label: `Impôt estimé (${marginal} %)`, width: 170, align: 'right',
        title: 'Gain imposable × ton taux marginal. Estimation seulement : rien n’est retiré du portefeuille simulé.',
        value: (r) => Math.max(0, r.realized * (inclusion / 100) * (marginal / 100)), format: (v) => money(v as number),
      },
    ];
  }, [inclusion, marginal, lastYear, lastYearPartial, asOf]);

  const totals = useMemo(() => {
    const realized = tax.years.reduce((a, y) => a + y.realized, 0);
    const dividends = tax.years.reduce((a, y) => a + y.dividends, 0);
    const taxDue = tax.years.reduce((a, y) => a + Math.max(0, y.realized * (inclusion / 100) * (marginal / 100)), 0);
    const last = tax.years[tax.years.length - 1];
    return { realized, dividends, taxDue, unrealized: last?.unrealized_end ?? 0, acb: last?.acb_end ?? 0, mv: last?.market_value_end ?? 0 };
  }, [tax, inclusion, marginal]);

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
            Rapport PBR reconstruit après le backtest (coût moyen par titre).
            {tax.dividends_reinvested === false ? ' Dividendes encaissés en cash.' : ' Dividendes réinvestis (augmentent le PBR).'}
            {' '}Si « Impôt canadien retiré du portefeuille » est coché, la courbe de valeur a déjà été amputée chaque saison fiscale ; ce tableau reste le détail PBR / gains.
          </div>
        </div>
        <div className={styles.toolbarInline}>
          <label className={styles.inlineField} title="Part du gain en capital qui entre dans le revenu imposable. Au fédéral, c’est en général 50 %.">
            Taux d&apos;inclusion
            <input type="number" className="input" style={{ width: 80 }} min={0} max={100} step={0.01} value={inclusion} onChange={(e) => setInclusion(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
            %
          </label>
          <label className={styles.inlineField} title="Ton taux d’impôt sur la dernière tranche de revenu (fédéral + provincial). Sert seulement à estimer l’impôt : ex. 53 % au Québec en haut de barre.">
            Taux marginal
            <input type="number" className="input" style={{ width: 80 }} min={0} max={100} step={0.01} value={marginal} onChange={(e) => setMarginal(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
            %
          </label>
        </div>
      </div>
      <div className={styles.kpis}>
        <div><span>Gains réalisés cumulés</span><strong style={signColor(totals.realized)}>{money(totals.realized)}</strong></div>
        <div><span>Imposable ({inclusion} %)</span><strong>{money(totals.realized * inclusion / 100)}</strong></div>
        <div><span>Impôt estimé ({marginal} %)</span><strong>{money(totals.taxDue)}</strong></div>
        <div><span>Dividendes cumulés</span><strong>{money(totals.dividends)}</strong></div>
        <div><span>Valeur marchande</span><strong>{money(totals.mv)}</strong></div>
        <div><span>PBR total</span><strong>{money(totals.acb)}</strong></div>
        <div title="Valeur marchande − PBR des titres encore détenus. Négatif = tu as plus de coût fiscal que de valeur de marché sur ce qui reste.">
          <span>Plus-value latente</span>
          <strong style={signColor(totals.unrealized)}>{money(totals.unrealized)}</strong>
        </div>
      </div>
      <div className={styles.padded}>
        <div className={styles.subTitle}>Sommaire annuel</div>
        <p className={styles.cardSub} style={{ marginBottom: '0.55rem' }}>
          Un gros saut d’achats / ventes / gains sur une année vient surtout d’un fort roulement (momentum qui change souvent de titres), pas d’une vente forcée en fin de simulation.
          {lastYearPartial && asOf ? ` La dernière année (${lastYear}) s’arrête au ${frDay(asOf)}, ce n’est pas une année civile complète.` : ''}
          {' '}La plus-value latente = valeur marchande − PBR encore détenu : elle peut passer en négatif après avoir vendu des gagnants.
        </p>
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
