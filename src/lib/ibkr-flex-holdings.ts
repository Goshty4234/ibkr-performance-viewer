import { parseNumber, parseReportDate, scanFlexSections } from './flex-csv';


/**
 * Open Positions and Trades sections of the Flex Query: what the account held each day and what it
 * traded. Everything is read as IBKR wrote it and converted to the account's base currency with the
 * FX rate IBKR gives on the same row. Nothing is estimated.
 *
 * Checked on a real file: the open positions (summary rows) add up to the NAV "Stock" + "Options"
 * of every one of 261 days, to the cent.
 */

export interface HoldingSymbol {
  /** Symbol as IBKR writes it (an option's symbol carries its strike and expiry). */
  symbol: string;
  /** Readable name (company or option description). */
  label: string;
  /** STK, OPT, FUT, CASH... */
  assetClass: string;
  /** COMMON, ETF, C, P... */
  sub: string;
  underlying: string;
  currency: string;
}

export interface HoldingPosition {
  /** Index into `symbols`. */
  s: number;
  /** Signed quantity (negative: short). */
  qty: number;
  /** Mark price in the instrument's currency. */
  price: number;
  /** Position value in base currency (negative for a short). */
  value: number;
  /** Cost basis in base currency. */
  cost: number;
  /** Unrealised P&L in base currency. */
  pnl: number;
}

export interface HoldingDay {
  date: string;
  positions: HoldingPosition[];
}

export interface HoldingTrade {
  date: string;
  /** Time of day (HHMMSS) when IBKR gives it, else empty. */
  time: string;
  symbol: string;
  label: string;
  assetClass: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  currency: string;
  /** Amounts in base currency. */
  proceeds: number;
  commission: number;
  taxes: number;
  realized: number;
  /** O (open), C (close) or both. */
  openClose: string;
}

export interface HoldingsData {
  symbols: HoldingSymbol[];
  days: HoldingDay[];
  trades: HoldingTrade[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function pick(headers: string[]) {
  const idx = new Map<string, number>();
  headers.forEach((h, i) => { if (!idx.has(h.toLowerCase())) idx.set(h.toLowerCase(), i); });
  return (name: string) => idx.get(name.toLowerCase()) ?? -1;
}

function cell(row: string[], i: number): string {
  return i >= 0 ? row[i] ?? '' : '';
}

function fxOf(row: string[], i: number): number {
  const v = i >= 0 ? parseNumber(row[i]) : 0;
  return v > 0 ? v : 1;
}

function dateOf(raw: string): string | null {
  const s = (raw ?? '').split(/[;, ]/)[0];
  if (!s) return null;
  try {
    return parseReportDate(s);
  } catch {
    return null;
  }
}

export function hasFlexHoldings(text: string): boolean {
  return scanFlexSections(text).some((s) => s.kind === 'positions' || s.kind === 'trades');
}

export function parseFlexHoldings(text: string): HoldingsData {
  const sections = scanFlexSections(text);
  const symbols: HoldingSymbol[] = [];
  const symIndex = new Map<string, number>();
  const byDay = new Map<string, Map<number, HoldingPosition>>();

  const internSymbol = (sym: HoldingSymbol): number => {
    const key = `${sym.assetClass}|${sym.symbol}`;
    let i = symIndex.get(key);
    if (i === undefined) {
      i = symbols.length;
      symIndex.set(key, i);
      symbols.push(sym);
    }
    return i;
  };

  // IBKR writes both a SUMMARY row per position and one row per LOT: only one of them may be counted.
  const posSections = sections.filter((s) => s.kind === 'positions');
  const hasSummary = posSections.some((s) => {
    const lvl = pick(s.headers)('levelofdetail');
    return lvl >= 0 && s.rows.some((r) => cell(r, lvl).toUpperCase() === 'SUMMARY');
  });

  for (const section of posSections) {
    const c = pick(section.headers);
    const iSym = c('symbol');
    const iDate = c('reportdate');
    const iQty = c('quantity');
    const iVal = c('positionvalue');
    if (iSym < 0 || iDate < 0 || iQty < 0 || iVal < 0) continue;
    const iLvl = c('levelofdetail');

    for (const row of section.rows) {
      const level = cell(row, iLvl).toUpperCase();
      if (hasSummary ? level !== 'SUMMARY' : level !== 'LOT' && level !== '') continue;
      const date = dateOf(cell(row, iDate));
      const symbol = cell(row, iSym);
      if (!date || !symbol) continue;
      const fx = fxOf(row, c('fxratetobase'));
      const sIdx = internSymbol({
        symbol,
        label: cell(row, c('description')) || symbol,
        assetClass: cell(row, c('assetclass')) || 'STK',
        sub: cell(row, c('subcategory')),
        underlying: cell(row, c('underlyingsymbol')),
        currency: cell(row, c('currencyprimary')),
      });
      const qty = parseNumber(cell(row, iQty));
      const pos: HoldingPosition = {
        s: sIdx,
        qty: r4(qty),
        price: r4(parseNumber(cell(row, c('markprice')))),
        value: r2(parseNumber(cell(row, iVal)) * fx),
        cost: r2(parseNumber(cell(row, c('costbasismoney'))) * fx),
        pnl: r2(parseNumber(cell(row, c('fifopnlunrealized'))) * fx),
      };
      let day = byDay.get(date);
      if (!day) { day = new Map(); byDay.set(date, day); }
      const prev = day.get(sIdx);
      if (prev) {
        // Lot rows of one symbol: add them up.
        prev.qty = r4(prev.qty + pos.qty);
        prev.value = r2(prev.value + pos.value);
        prev.cost = r2(prev.cost + pos.cost);
        prev.pnl = r2(prev.pnl + pos.pnl);
      } else {
        day.set(sIdx, pos);
      }
    }
  }

  const days: HoldingDay[] = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, m]) => ({ date, positions: [...m.values()] }));

  // Trades: one row per execution (the ORDER, SYMBOL_SUMMARY, ASSET_SUMMARY and CLOSED_LOT rows repeat them).
  const trades: HoldingTrade[] = [];
  const tradeSections = sections.filter((s) => s.kind === 'trades');
  const levels = new Set<string>();
  for (const s of tradeSections) {
    const l = pick(s.headers)('levelofdetail');
    if (l >= 0) for (const r of s.rows) levels.add(cell(r, l).toUpperCase());
  }
  const wanted = levels.has('EXECUTION') ? 'EXECUTION' : levels.has('ORDER') ? 'ORDER' : '';

  for (const section of tradeSections) {
    const c = pick(section.headers);
    const iLvl = c('levelofdetail');
    for (const row of section.rows) {
      if (wanted && cell(row, iLvl).toUpperCase() !== wanted) continue;
      const side = cell(row, c('buy/sell')).toUpperCase();
      if (side !== 'BUY' && side !== 'SELL') continue;
      const date = dateOf(cell(row, c('tradedate'))) ?? dateOf(cell(row, c('reportdate')));
      if (!date) continue;
      const fx = fxOf(row, c('fxratetobase'));
      const dt = cell(row, c('datetime'));
      trades.push({
        date,
        time: dt.includes(';') ? dt.split(';')[1] : '',
        symbol: cell(row, c('symbol')),
        label: cell(row, c('description')) || cell(row, c('symbol')),
        assetClass: cell(row, c('assetclass')) || 'STK',
        side,
        qty: Math.abs(r4(parseNumber(cell(row, c('quantity'))))),
        price: r4(parseNumber(cell(row, c('tradeprice')))),
        currency: cell(row, c('currencyprimary')),
        proceeds: r2(parseNumber(cell(row, c('proceeds'))) * fx),
        commission: r2(parseNumber(cell(row, c('ibcommission'))) * fx),
        taxes: r2(parseNumber(cell(row, c('taxes'))) * fx),
        realized: r2(parseNumber(cell(row, c('fifopnlrealized'))) * fx),
        openClose: cell(row, c('open/closeindicator')).replace('-', ''),
      });
    }
  }
  trades.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // Transaction Taxes section: charged apart from the trade, counted with its taxes.
  for (const section of sections.filter((s) => s.kind === 'taxes')) {
    const c = pick(section.headers);
    for (const row of section.rows) {
      const amount = parseNumber(cell(row, c('taxamount')));
      const date = dateOf(cell(row, c('date'))) ?? dateOf(cell(row, c('reportdate')));
      if (!amount || !date) continue;
      trades.push({
        date,
        time: '',
        symbol: cell(row, c('symbol')),
        label: cell(row, c('taxdescription')) || 'Taxe de transaction',
        assetClass: 'TAX',
        side: 'SELL',
        qty: 0,
        price: 0,
        currency: cell(row, c('currencyprimary')),
        proceeds: 0,
        commission: 0,
        taxes: r2(amount * fxOf(row, c('fxratetobase'))),
        realized: 0,
        openClose: '',
      });
    }
  }

  return { symbols, days, trades };
}
