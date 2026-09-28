/** Ticker helpers mirroring the Streamlit Multi-Backtest (get_ticker_aliases, resolve_ticker_alias, …). */

export const TICKER_ALIASES: Record<string, string> = {
  SPX: '^GSPC',
  SPXTR: '^SP500TR',
  SP500: '^GSPC',
  SP500TR: '^SP500TR',
  SPYTR: '^SP500TR',
  NASDAQ: '^IXIC',
  NDX: '^NDX',
  QQQTR: 'QQQ',
  DOW: '^DJI',
  TNX: '^TNX',
  TYX: '^TYX',
  FVX: '^FVX',
  IRX: '^IRX',
  TLTETF: 'TLT',
  IEFETF: 'IEF',
  SHY: 'SHY',
  BIL: 'BIL',
  GOVT: 'GOVT',
  SPTL: 'SPTL',
  SPTS: 'SPTS',
  SPTI: 'SPTI',
  ZEROX: 'ZEROX',
  GLD: 'GLD',
  IAU: 'IAU',
  GOLDF: 'GC=F',
  GOLD50: 'GOLD_COMPLETE',
  ZROZ50: 'ZROZ_COMPLETE',
  TLT50: 'TLT_COMPLETE',
  BTC50: 'BTC_COMPLETE',
  IEF50: 'IEF_COMPLETE',
  KMLM50: 'KMLM_COMPLETE',
  DBMF50: 'DBMF_COMPLETE',
  TBILL50: 'TBILL_COMPLETE',
  TBILL: 'TBILL_COMPLETE',
  IEFTR: 'IEF_COMPLETE',
  TLTTR: 'TLT_COMPLETE',
  ZROZX: 'ZROZ_COMPLETE',
  // Python dict: the later 'GOLDX' entry wins over the earlier 'GOLDX': 'GOLDX'.
  GOLDX: 'GOLD_COMPLETE',
  KMLMX: 'KMLM_COMPLETE',
  DBMFX: 'DBMF_COMPLETE',
  BITCOINX: 'BTC_COMPLETE',
  SPYSIM: 'SPYSIM_COMPLETE',
  GOLDSIM: 'GOLDSIM_COMPLETE',
  SILVER: 'SI=F',
  OIL: 'CL=F',
  NATGAS: 'NG=F',
  CORN: 'ZC=F',
  SOYBEAN: 'ZS=F',
  COFFEE: 'KC=F',
  SUGAR: 'SB=F',
  COTTON: 'CT=F',
  COPPER: 'HG=F',
  PLATINUM: 'PL=F',
  PALLADIUM: 'PA=F',
  BITCOIN: 'BTC-USD',
  TQQQND: '^NDX?L=3?E=0.95',
  QLDND: '^NDX?L=2?E=0.95',
  PSQND: '^NDX?L=-1?E=0.95',
  QIDND: '^NDX?L=-2?E=0.95',
  SQQQND: '^NDX?L=-3?E=0.95',
  TQQQIXIC: '^IXIC?L=3?E=0.95',
  QLDIXIC: '^IXIC?L=2?E=0.95',
  PSQIXIC: '^IXIC?L=-1?E=0.95',
  QIDIXIC: '^IXIC?L=-2?E=0.95',
  SQQQIXIC: '^IXIC?L=-3?E=0.95',
  SPXLTR: '^SP500TR?L=3?E=1.00',
  UPROTR: '^SP500TR?L=3?E=0.91',
  SSOTR: '^SP500TR?L=2?E=0.91',
  SHND: '^GSPC?L=-1?E=0.89',
  SDSND: '^GSPC?L=-2?E=0.91',
  SPXUND: '^GSPC?L=-3?E=1.00',
  TQQQTR: '^NDX?L=3?E=0.95',
  QLDTR: '^NDX?L=2?E=0.95',
  SHTR: '^GSPC?L=-1?E=0.89',
  PSQTR: '^NDX?L=-1?E=0.95',
  SDSTR: '^GSPC?L=-2?E=0.91',
  QIDTR: '^NDX?L=-2?E=0.95',
  SPXUTR: '^GSPC?L=-3?E=1.00',
  SQQQTR: '^NDX?L=-3?E=0.95',
  SP500TOP20: 'SP500TOP20',
  SPYND: '^GSPC',
  QQQND: '^IXIC',
  XLKND: '^SP500-45',
  XLVND: '^SP500-35',
  XLPND: '^SP500-30',
  XLFND: '^SP500-40',
  XLEND: '^SP500-10',
  XLIND: '^SP500-20',
  XLYND: '^SP500-25',
  XLBND: '^SP500-15',
  XLUND: '^SP500-55',
  XLREND: '^SP500-60',
  XLCND: '^SP500-50',
};

const ALIAS_TARGETS = new Set(Object.values(TICKER_ALIASES));

/**
 * Same steps as Streamlit's update_stock_ticker: commas → dots, upper case, BRK fix, alias.
 * Extra: underscores are ignored when that yields an alias (GOLD_SIM → GOLDSIM). Yahoo symbols
 * never contain "_", and the engine's own names (GOLDSIM_COMPLETE…) are kept as typed.
 */
export function resolveTicker(input: string): string {
  let t = input.trim().replace(/,/g, '.').toUpperCase();
  if (t === 'BRK.B') t = 'BRK-B';
  else if (t === 'BRK.A') t = 'BRK-A';
  if (TICKER_ALIASES[t]) return TICKER_ALIASES[t];
  if (t.includes('_') && !ALIAS_TARGETS.has(t)) {
    const compact = t.replace(/_/g, '');
    if (TICKER_ALIASES[compact]) return TICKER_ALIASES[compact];
  }
  return t;
}

/** Inverse ETFs (?L=-N) have dividends switched off, like Streamlit. */
export function isInverse(ticker: string): boolean {
  return ticker.includes('?L=-');
}

export interface TickerParams { base: string; leverage: number; expense: number }

export function parseTickerParameters(ticker: string): TickerParams {
  const t = ticker.replace(/,/g, '.');
  const q = t.indexOf('?');
  const base = q >= 0 ? t.slice(0, q) : t;
  const num = (re: RegExp, fallback: number) => {
    const m = t.match(re);
    const v = m ? Number(m[1]) : NaN;
    return Number.isFinite(v) ? v : fallback;
  };
  return { base, leverage: num(/\?L=(-?[\d.]+)/, 1), expense: num(/\?E=(-?[\d.]+)/, 0) };
}

/** apply_bulk_leverage_callback: base + ?L= (if ≠ 1) + ?E= (if ≠ 0). */
export function withLeverage(ticker: string, leverage: number, expense: number): string {
  let out = parseTickerParameters(ticker).base;
  if (leverage !== 1) out += `?L=${pyFloat(leverage)}`;
  if (expense !== 0) out += `?E=${pyFloat(expense)}`;
  return out;
}

/** str(float) in Python: integers keep a trailing ".0" (st.number_input values are floats). */
function pyFloat(v: number): string {
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}

export function splitTickerList(text: string): string[] {
  return text
    .replace(/[;,]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const NON_USD_SUFFIXES = ['.TO', '.V', '.CN', '.AX', '.L', '.PA', '.AS', '.SW', '.T', '.HK', '.KS', '.TW', '.JP'];

export function nonUsdTickers(tickers: string[]): string[] {
  return [...new Set(tickers.filter((t) => NON_USD_SUFFIXES.some((s) => t.endsWith(s))))];
}

export interface SpecialTicker { label: string; alias: string; help?: string }

export const SPECIAL_TICKERS: { group: string; items: SpecialTicker[] }[] = [
  {
    group: 'Indices boursiers',
    items: [
      { label: 'S&P 500 sans dividendes (1927+)', alias: 'SPYND' },
      { label: 'S&P 500 rendement total (1988+)', alias: 'SPYTR' },
      { label: 'NASDAQ sans dividendes (1971+)', alias: 'QQQND' },
      { label: 'NASDAQ 100 (1985+)', alias: 'NDX' },
      { label: 'Dow Jones (1992+)', alias: 'DOW' },
    ],
  },
  {
    group: 'Secteurs S&P 500 (1990+)',
    items: [
      { label: 'Technologie (XLK)', alias: 'XLKND' },
      { label: 'Santé (XLV)', alias: 'XLVND' },
      { label: 'Consommation de base (XLP)', alias: 'XLPND' },
      { label: 'Finance (XLF)', alias: 'XLFND' },
      { label: 'Énergie (XLE)', alias: 'XLEND' },
      { label: 'Industrie (XLI)', alias: 'XLIND' },
      { label: 'Consommation discrétionnaire (XLY)', alias: 'XLYND' },
      { label: 'Matériaux (XLB)', alias: 'XLBND' },
      { label: 'Services publics (XLU)', alias: 'XLUND' },
      { label: 'Immobilier (XLRE)', alias: 'XLREND' },
      { label: 'Communication (XLC)', alias: 'XLCND' },
    ],
  },
  {
    group: 'Séries complètes / synthétiques',
    items: [
      { label: 'Simulation S&P 500 complète (1885+)', alias: 'SPYSIM' },
      { label: 'S&P 500 Top 20 dynamique', alias: 'SP500TOP20', help: 'BÊTA : top 20 du S&P 500 par capitalisation historique, rééquilibré chaque année. Nécessite TOP_20_SP500_COMPLETE_TEMPLATE.csv dans le dossier du moteur (absent pour l’instant).' },
      { label: 'Simulateur de cash (ZEROX)', alias: 'ZEROX', help: 'Position cash qui ne bouge pas (ni prix, ni dividendes)' },
      { label: 'T-Bills complet (1885+)', alias: 'TBILL' },
      { label: 'IEF complet (1962+)', alias: 'IEFTR' },
      { label: 'TLT complet (1962+)', alias: 'TLTTR' },
      { label: 'ZROZ complet (1962+)', alias: 'ZROZX' },
      { label: 'Simulation or (1968+)', alias: 'GOLDSIM' },
      { label: 'Or complet (1975+)', alias: 'GOLDX' },
      { label: 'KMLM complet (1992+)', alias: 'KMLMX' },
      { label: 'DBMF complet (2000+)', alias: 'DBMFX' },
      { label: 'Bitcoin complet (2010+)', alias: 'BITCOINX' },
    ],
  },
  {
    group: 'ETF à levier simulés',
    items: [
      { label: 'TQQQ simulé (3x NDX, 1985+)', alias: 'TQQQND' },
      { label: 'QLD simulé (2x NDX, 1985+)', alias: 'QLDND' },
      { label: 'PSQ simulé (-1x NDX, 1985+)', alias: 'PSQND' },
      { label: 'QID simulé (-2x NDX, 1985+)', alias: 'QIDND' },
      { label: 'SQQQ simulé (-3x NDX, 1985+)', alias: 'SQQQND' },
      { label: 'TQQQ-IXIC (3x Composite, 1971+)', alias: 'TQQQIXIC', help: 'Attention : suit le NASDAQ Composite, pas le NASDAQ-100 comme le vrai ETF' },
      { label: 'QLD-IXIC (2x Composite, 1971+)', alias: 'QLDIXIC', help: 'Attention : suit le NASDAQ Composite, pas le NASDAQ-100' },
      { label: 'PSQ-IXIC (-1x Composite, 1971+)', alias: 'PSQIXIC', help: 'Attention : suit le NASDAQ Composite, pas le NASDAQ-100' },
      { label: 'QID-IXIC (-2x Composite, 1971+)', alias: 'QIDIXIC', help: 'Attention : suit le NASDAQ Composite, pas le NASDAQ-100' },
      { label: 'SQQQ-IXIC (-3x Composite, 1971+)', alias: 'SQQQIXIC', help: 'Attention : suit le NASDAQ Composite, pas le NASDAQ-100' },
      { label: 'SPXL simulé (3x SPY, 1988+)', alias: 'SPXLTR' },
      { label: 'UPRO simulé (3x SPY, 1988+)', alias: 'UPROTR' },
      { label: 'SSO simulé (2x SPY, 1988+)', alias: 'SSOTR' },
      { label: 'SH simulé (-1x SPY, 1927+)', alias: 'SHND' },
      { label: 'SDS simulé (-2x SPY, 1927+)', alias: 'SDSND' },
      { label: 'SPXU simulé (-3x SPY, 1927+)', alias: 'SPXUND' },
    ],
  },
];

/** Short aliases worth remembering (Streamlit "Ticker Aliases" cheat sheet). */
export const ALIAS_CHEATSHEET: [string, string][] = [
  ['SPX', 'S&P 500 prix (1927+)'],
  ['SPYTR / SPXTR', 'S&P 500 rendement total (1988+)'],
  ['QQQTR', 'NASDAQ-100 avec dividendes (QQQ)'],
  ['TLTETF / IEFETF', 'ETF TLT / IEF (2002+)'],
  ['TLTTR / IEFTR / ZROZX', 'Séries obligataires complètes (1962+)'],
  ['TNX / TYX / IRX', 'Taux 10 ans / 30 ans / 3 mois'],
  ['TBILL', 'T-Bills complet (1885+)'],
  ['SPYSIM', 'S&P 500 simulé (1885+)'],
  ['GOLDSIM / GOLDX', 'Or simulé (1968+) / complet (1975+)'],
  ['KMLMX / DBMFX', 'Managed futures complets'],
  ['BITCOINX', 'Bitcoin complet (2010+)'],
  ['ZEROX', 'Cash qui ne fait rien'],
  ['TICKER?L=2', 'Levier quotidien x2 (coût = (L-1) × taux sans risque)'],
  ['TICKER?E=0.95', 'Frais annuels 0,95 %'],
];

export interface SpecialSuggestion { alias: string; target: string; label: string; group: string }

const compactKey = (s: string) => s.toUpperCase().replace(/[\s_.\-^=?]/g, '');
const plain = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Every alias the engine understands, described ones first (SPECIAL_TICKERS), then the raw alias table. */
const SPECIAL_INDEX: (SpecialSuggestion & { keys: string[]; words: string[] })[] = (() => {
  const out: (SpecialSuggestion & { keys: string[]; words: string[] })[] = [];
  const seen = new Set<string>();
  const push = (alias: string, label: string, group: string) => {
    if (seen.has(alias)) return;
    seen.add(alias);
    const target = TICKER_ALIASES[alias] ?? alias;
    const words = plain(`${label} ${group}`).split(/[^a-z0-9&]+/).filter(Boolean);
    out.push({ alias, target, label, group, keys: [compactKey(alias), compactKey(target)], words });
  };
  for (const g of SPECIAL_TICKERS) for (const it of g.items) push(it.alias, it.label, g.group);
  for (const [alias, target] of Object.entries(TICKER_ALIASES)) {
    if (alias !== target) push(alias, `Alias de ${target}`, 'Alias');
  }
  return out;
})();

/** Local matches for the ticker box: alias or engine name (ignoring _ - . spaces), then label words. */
export function searchSpecialTickers(query: string, limit = 6): SpecialSuggestion[] {
  const key = compactKey(query);
  const words = plain(query).split(/\s+/).filter((w) => w.length >= 2);
  if (key.length < 2 || query.includes('?')) return [];
  const scored: [number, number, SpecialSuggestion][] = [];
  SPECIAL_INDEX.forEach((e, i) => {
    let score = 0;
    if (e.keys[0] === key) score = 4;
    else if (e.keys[1] === key) score = 3;
    else if (e.keys.some((k) => k.startsWith(key))) score = 2;
    else if (words.length && words.every((w) => e.words.some((x) => x.startsWith(w)))) score = 1;
    if (score) scored.push([score, i, e]);
  });
  return scored
    .sort((a, b) => b[0] - a[0] || a[1] - b[1])
    .slice(0, limit)
    .map(([, , { alias, target, label, group }]) => ({ alias, target, label, group }));
}
