import type { CSSProperties } from 'react';
import type { FundamentalsRow } from '@/lib/engine/types';
import type { GridColumn } from '../grid/DataGrid';
import { money, num, pct, signColor } from '../results/format';

type Kind = 'ticker' | 'text' | 'money' | 'pct' | 'ratio' | 'bn' | 'mn' | 'int' | 'qty';
type Value = number | string | null | undefined;

interface FieldDef {
  label: string;
  kind: Kind;
  width?: number;
  title?: string;
  style?: (v: Value) => CSSProperties | undefined;
}

export function peColor(v: Value): CSSProperties | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return { color: v >= 35 ? 'var(--red)' : v >= 25 ? 'var(--orange)' : 'var(--green)', fontWeight: 600 };
}

function ratingColor(v: Value): CSSProperties | undefined {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('buy')) return { color: 'var(--green)', fontWeight: 600 };
  if (s.includes('sell') || s.includes('underperform')) return { color: 'var(--red)', fontWeight: 600 };
  if (s.includes('hold')) return { color: 'var(--orange)', fontWeight: 600 };
  return undefined;
}

const RATING_FR: Record<string, string> = {
  'Strong_Buy': 'Achat fort', 'Buy': 'Achat', 'Hold': 'Conserver', 'Underperform': 'Sous-performance',
  'Sell': 'Vente', 'Strong_Sell': 'Vente forte', 'None': 'N/A',
};

export const FIELDS: Record<string, FieldDef> = {
  ticker: { label: 'Ticker', kind: 'ticker', width: 92 },
  name: { label: 'Société', kind: 'text', width: 230 },
  sector: { label: 'Secteur', kind: 'text', width: 160 },
  industry: { label: 'Industrie', kind: 'text', width: 190 },
  price: { label: 'Prix', kind: 'money', width: 100 },
  alloc_pct: { label: 'Allocation', kind: 'pct', width: 96 },
  shares: { label: 'Actions', kind: 'qty', width: 84 },
  value: { label: 'Valeur', kind: 'money', width: 116 },
  pct_of_portfolio: { label: '% portefeuille', kind: 'pct', width: 110 },
  market_cap_b: { label: 'Capitalisation', kind: 'bn', width: 116 },
  enterprise_value_b: { label: 'Valeur d’entreprise', kind: 'bn', width: 140 },
  pe: { label: 'P/E', kind: 'ratio', width: 76, style: peColor },
  forward_pe: { label: 'P/E prév.', kind: 'ratio', width: 86, style: peColor, title: 'P/E prévisionnel (forward)' },
  peg: { label: 'PEG', kind: 'ratio', width: 70 },
  peg_source: { label: 'Source PEG', kind: 'text', width: 160 },
  price_book: { label: 'P/B', kind: 'ratio', width: 70, title: 'Cours / valeur comptable' },
  price_sales: { label: 'P/S', kind: 'ratio', width: 70, title: 'Cours / ventes' },
  price_cash_flow: { label: 'P/CF', kind: 'ratio', width: 70, title: 'Cours / flux de trésorerie' },
  price_fcf: { label: 'P/FCF', kind: 'ratio', width: 76, title: 'Cours / flux de trésorerie disponible' },
  ev_ebitda: { label: 'EV/EBITDA', kind: 'ratio', width: 96 },
  fcf_yield: { label: 'Rdt FCF', kind: 'pct', width: 86, style: signColor, title: 'Rendement du flux de trésorerie disponible' },
  fcf_b: { label: 'FCF', kind: 'bn', width: 90, style: signColor },
  shares_outstanding_m: { label: 'Actions en circ.', kind: 'mn', width: 124 },
  float_shares_m: { label: 'Flottant', kind: 'mn', width: 100 },
  revenue_b: { label: 'Revenus TTM', kind: 'bn', width: 110 },
  earnings_b: { label: 'Bénéfices TTM', kind: 'bn', width: 116, style: signColor },
  book_value: { label: 'Valeur comptable/act.', kind: 'money', width: 150 },
  cash_per_share: { label: 'Encaisse/act.', kind: 'money', width: 110 },
  revenue_per_share: { label: 'Revenus/act.', kind: 'money', width: 110 },
  target_price: { label: 'Cible', kind: 'money', width: 96, title: 'Cours cible moyen des analystes' },
  target_high: { label: 'Cible haute', kind: 'money', width: 100 },
  target_low: { label: 'Cible basse', kind: 'money', width: 100 },
  debt_equity: { label: 'Dette/CP', kind: 'ratio', width: 86, title: 'Dette / capitaux propres' },
  total_debt_b: { label: 'Dette totale', kind: 'bn', width: 106 },
  net_debt_b: { label: 'Dette nette', kind: 'bn', width: 100 },
  current_ratio: { label: 'Ratio courant', kind: 'ratio', width: 106 },
  quick_ratio: { label: 'Ratio rapide', kind: 'ratio', width: 100 },
  working_capital_b: { label: 'Fonds de roulement', kind: 'bn', width: 140, style: signColor },
  interest_coverage: { label: 'Couverture intérêts', kind: 'ratio', width: 140 },
  roe: { label: 'ROE', kind: 'pct', width: 80, style: signColor },
  roa: { label: 'ROA', kind: 'pct', width: 80, style: signColor },
  roic: { label: 'ROIC', kind: 'pct', width: 80, style: signColor },
  profit_margin: { label: 'Marge nette', kind: 'pct', width: 100, style: signColor },
  operating_margin: { label: 'Marge opér.', kind: 'pct', width: 100, style: signColor },
  gross_margin: { label: 'Marge brute', kind: 'pct', width: 100, style: signColor },
  revenue_growth: { label: 'Croiss. revenus', kind: 'pct', width: 120, style: signColor },
  earnings_growth: { label: 'Croiss. bénéfices', kind: 'pct', width: 130, style: signColor },
  eps_growth: { label: 'Croiss. BPA', kind: 'pct', width: 104, style: signColor },
  dividend_yield: { label: 'Rdt dividende', kind: 'pct', width: 110 },
  dividend_rate: { label: 'Dividende/an', kind: 'money', width: 110 },
  payout_ratio: { label: 'Taux de distribution', kind: 'pct', width: 150 },
  dividend_growth_5y: { label: 'Rdt moyen 5 ans', kind: 'pct', width: 124, title: 'Rendement du dividende moyen sur 5 ans' },
  high_52w: { label: 'Haut 52 sem.', kind: 'money', width: 110 },
  low_52w: { label: 'Bas 52 sem.', kind: 'money', width: 104 },
  ma_50: { label: 'MM 50 j', kind: 'money', width: 96 },
  ma_200: { label: 'MM 200 j', kind: 'money', width: 100 },
  beta: { label: 'Bêta', kind: 'ratio', width: 72 },
  volume: { label: 'Volume', kind: 'int', width: 120 },
  avg_volume: { label: 'Volume moyen', kind: 'int', width: 124 },
  analyst_rating: { label: 'Analystes', kind: 'text', width: 120, style: ratingColor },
};

export type FundTab = 'overview' | 'valuation' | 'health' | 'growth' | 'technical';

export const FUND_TABS: { id: FundTab; label: string; fields: string[] }[] = [
  {
    id: 'overview',
    label: 'Vue d’ensemble',
    fields: ['ticker', 'name', 'sector', 'industry', 'price', 'alloc_pct', 'shares', 'value', 'pct_of_portfolio', 'market_cap_b', 'pe', 'peg', 'peg_source', 'beta', 'analyst_rating'],
  },
  {
    id: 'valuation',
    label: 'Valorisation',
    fields: ['ticker', 'price', 'market_cap_b', 'enterprise_value_b', 'pe', 'forward_pe', 'peg', 'peg_source', 'price_book', 'price_sales', 'price_cash_flow', 'price_fcf', 'ev_ebitda', 'fcf_yield', 'fcf_b', 'shares_outstanding_m', 'float_shares_m', 'revenue_b', 'earnings_b', 'book_value', 'cash_per_share', 'revenue_per_share', 'target_price', 'target_high', 'target_low'],
  },
  {
    id: 'health',
    label: 'Santé financière',
    fields: ['ticker', 'debt_equity', 'total_debt_b', 'net_debt_b', 'current_ratio', 'quick_ratio', 'working_capital_b', 'interest_coverage', 'roe', 'roa', 'roic', 'profit_margin', 'operating_margin', 'gross_margin'],
  },
  {
    id: 'growth',
    label: 'Croissance & dividendes',
    fields: ['ticker', 'revenue_growth', 'earnings_growth', 'eps_growth', 'dividend_yield', 'dividend_rate', 'payout_ratio', 'dividend_growth_5y'],
  },
  {
    id: 'technical',
    label: 'Technique',
    fields: ['ticker', 'price', 'high_52w', 'low_52w', 'ma_50', 'ma_200', 'beta', 'volume', 'avg_volume'],
  },
];

export function formatField(kind: Kind, v: Value): string {
  if (v === null || v === undefined || v === '') return 'N/A';
  if (kind === 'ticker' || kind === 'text') return String(v);
  if (typeof v !== 'number' || !Number.isFinite(v)) return 'N/A';
  switch (kind) {
    case 'money': return money(v);
    case 'pct': return pct(v);
    case 'ratio': return num(v);
    case 'bn': return `$${v.toFixed(2)} B`;
    case 'mn': return `${v.toLocaleString('fr-CA', { maximumFractionDigits: 1 })} M`;
    case 'int': return Math.round(v).toLocaleString('fr-CA');
    case 'qty': return v.toFixed(1);
    default: return String(v);
  }
}

export function fundColumns(fields: string[]): GridColumn<FundamentalsRow>[] {
  return fields.map((key) => {
    const f = FIELDS[key];
    const numeric = !['ticker', 'text'].includes(f.kind);
    return {
      key,
      label: f.label,
      title: f.title ?? f.label,
      width: f.width,
      align: numeric ? 'right' : 'left',
      value: (r) => {
        const v = r[key];
        if (key === 'analyst_rating') return v && v !== 'N/A' ? RATING_FR[String(v)] ?? String(v).replace(/_/g, ' ') : null;
        return typeof v === 'boolean' ? null : v;
      },
      format: (v, r) => {
        if (key === 'interest_coverage' && r.interest_coverage_unbounded) return '∞';
        if (key === 'ticker') return <strong>{String(v)}</strong>;
        const text = formatField(f.kind, v);
        if (text === 'N/A') return <span style={{ color: 'var(--text-faint)' }}>N/A</span>;
        return f.kind === 'text' ? <span title={text}>{text}</span> : text;
      },
      cellStyle: f.style ? (v) => f.style!(v) : undefined,
    };
  });
}
