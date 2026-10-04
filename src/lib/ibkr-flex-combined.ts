import type { CashFlow, DailyNavPoint, DailyTwrPoint, ParsedNavSeries } from './types';
import {
  headerIndex,
  isNavReportDate,
  parseNumber,
  parseReportDate,
  scanFlexSections,
} from './flex-csv';

function isTwrrCashType(type: string, description: string): boolean {
  const t = `${type} ${description}`.toLowerCase();
  if (/dividend|interest|commission|fee|withhold|tax|coupon|payment in lieu|adj|accrual|broker interest/.test(t)) {
    return false;
  }
  if (/deposit|withdraw|transfer|disbur|wire|ach|electronic fund|internal/.test(t)) {
    return true;
  }
  return false;
}

export { isFlexCombinedCsv } from './flex-csv';

export function parseFlexCombinedCsv(
  text: string,
  filename: string,
): { nav: ParsedNavSeries; cashFlows: CashFlow[]; twrDaily: DailyTwrPoint[] } {
  const sections = scanFlexSections(text);
  const navSections = sections.filter((s) => s.kind === 'nav');
  const cashSections = sections.filter((s) => s.kind === 'cash');
  const transferSections = sections.filter((s) => s.kind === 'transfer');
  const changeSections = sections.filter((s) => s.kind === 'changeNav');

  if (!navSections.length) {
    throw new Error(`Aucune section NAV dans ${filename}`);
  }

  const byDate = new Map<string, DailyNavPoint>();
  let accountId = '';
  let accountAlias = '';
  let baseCurrency = 'CAD';

  for (const section of navSections) {
    const headers = section.headers;
    const dateCol = headers.findIndex((h) => h.toLowerCase() === 'reportdate');
    const totalCol = headers.findIndex((h) => h.toLowerCase() === 'total');
    const cashCol = headers.findIndex((h) => h.toLowerCase() === 'cash');
    const stockCol = headers.findIndex((h) => h.toLowerCase() === 'stock');
    const optionsCol = headers.findIndex((h) => h.toLowerCase() === 'options');
    const accountCol = headers.findIndex((h) => h.toLowerCase() === 'clientaccountid');
    const aliasCol = headers.findIndex((h) => h.toLowerCase() === 'accountalias');
    const currencyCol = headers.findIndex((h) => h.toLowerCase() === 'currencyprimary');

    for (const row of section.rows) {
      const rawAccount = accountCol >= 0 ? row[accountCol] : '';
      if (!rawAccount || rawAccount === 'ClientAccountID') continue;

      const rawDate = row[dateCol];
      if (!isNavReportDate(rawDate)) continue;

      if (!accountId) {
        accountId = rawAccount;
        accountAlias = aliasCol >= 0 ? row[aliasCol] ?? '' : '';
        baseCurrency = currencyCol >= 0 ? row[currencyCol] || 'CAD' : 'CAD';
      } else if (rawAccount !== accountId) {
        throw new Error(`Plusieurs comptes dans ${filename}`);
      }

      const date = parseReportDate(rawDate);
      const point: DailyNavPoint = { date, total: parseNumber(row[totalCol]) };
      if (cashCol >= 0) point.cash = parseNumber(row[cashCol]);
      if (stockCol >= 0) point.stock = parseNumber(row[stockCol]);
      if (optionsCol >= 0) point.options = parseNumber(row[optionsCol]);
      byDate.set(date, point);
    }
  }

  const points = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!points.length) throw new Error(`Aucune NAV quotidienne dans ${filename}`);
  if (!accountId) throw new Error(`Compte IBKR introuvable dans ${filename}`);

  const cashFlows: CashFlow[] = [];

  for (const section of cashSections) {
    const headers = section.headers;
    const dateCol = headerIndex(headers, 'settledate', 'reportdate', 'date/time');
    const amountCol = headers.findIndex((h) => h.toLowerCase() === 'amount');
    // Exact names first: a loose match would pick SecurityIDType (or similar) instead of Type.
    const exactCol = (name: string) => headers.findIndex((h) => h.toLowerCase() === name);
    const typeCol = exactCol('type') >= 0 ? exactCol('type') : headerIndex(headers, 'type');
    const descCol = exactCol('description') >= 0 ? exactCol('description') : headerIndex(headers, 'description');
    const fxCol = headers.findIndex((h) => h.toLowerCase() === 'fxratetobase');

    for (const row of section.rows) {
      const type = typeCol >= 0 ? row[typeCol] ?? '' : '';
      const description = descCol >= 0 ? row[descCol] ?? '' : '';
      if (!isTwrrCashType(type, description)) continue;

      const rawAmount = parseNumber(row[amountCol]);
      if (!rawAmount) continue;

      const fx = fxCol >= 0 ? parseNumber(row[fxCol]) : 1;
      const amount = fx > 0 && fx !== 1 ? rawAmount * fx : rawAmount;

      cashFlows.push({
        date: parseReportDate(row[dateCol]),
        amount,
        description: description || type,
        isExternal: true,
      });
    }
  }

  // Shares moved in or out (ACATS, FOP, internal): NAV changes with no cash movement, and IBKR counts
  // it as a deposit/withdrawal. Valued at the transfer's position amount in base currency.
  for (const section of transferSections) {
    const headers = section.headers;
    const col = (name: string) => headers.findIndex((h) => h.toLowerCase() === name);
    const dateCol = [col('reportdate'), col('date'), col('datetime')].find((i) => i >= 0) ?? -1;
    const dirCol = col('direction');
    const baseCol = col('positionamountinbase');
    const posCol = col('positionamount');
    const fxCol = col('fxratetobase');
    const typeCol = col('type');
    const symbolCol = col('symbol');
    if (dateCol < 0 || dirCol < 0 || (baseCol < 0 && posCol < 0)) continue;

    for (const row of section.rows) {
      let value = baseCol >= 0 ? Math.abs(parseNumber(row[baseCol])) : 0;
      if (!value && posCol >= 0) {
        const fx = fxCol >= 0 ? parseNumber(row[fxCol]) : 1;
        value = Math.abs(parseNumber(row[posCol])) * (fx > 0 ? fx : 1);
      }
      if (!value) continue;

      const sign = (row[dirCol] ?? '').trim().toUpperCase().startsWith('OUT') ? -1 : 1;
      let date: string;
      try {
        date = parseReportDate((row[dateCol] ?? '').split(/[;, ]/)[0]);
      } catch {
        continue;
      }
      const label = [typeCol >= 0 ? row[typeCol] : '', symbolCol >= 0 ? row[symbolCol] : ''].filter(Boolean).join(' ');
      cashFlows.push({
        date,
        amount: sign * value,
        description: `Transfert de titres ${sign > 0 ? 'entrant' : 'sortant'}${label ? ` (${label})` : ''}`,
        isExternal: true,
      });
    }
  }

  // Change in NAV (Breakout by Day): IBKR's own daily TWR and, per day, the deposits, withdrawals and
  // asset transfers it removed from that return. This is the exact source: when present it replaces
  // the flows read from the other sections (same events, would otherwise be counted twice).
  const twrDaily: DailyTwrPoint[] = [];
  const changeFlows: CashFlow[] = [];
  for (const section of changeSections) {
    const headers = section.headers;
    const col = (name: string) => headers.findIndex((h) => h.toLowerCase() === name);
    const fromCol = col('fromdate');
    const toCol = col('todate');
    const twrCol = col('twr');
    const flowCols = ['depositswithdrawals', 'assettransfers', 'internalcashtransfers'].map(col).filter((i) => i >= 0);
    if (fromCol < 0 || toCol < 0 || twrCol < 0) continue;

    for (const row of section.rows) {
      const from = row[fromCol] ?? '';
      const to = row[toCol] ?? '';
      if (!isNavReportDate(to) || from !== to) continue; // daily rows only (period totals are skipped)
      const date = parseReportDate(to);
      twrDaily.push({ date, returnPct: parseNumber(row[twrCol]) });
      const amount = flowCols.reduce((sum, i) => sum + parseNumber(row[i]), 0);
      if (Math.abs(amount) > 0.005) {
        changeFlows.push({ date, amount, description: 'Flux IBKR (Change in NAV)', isExternal: true });
      }
    }
  }
  twrDaily.sort((a, b) => a.date.localeCompare(b.date));
  if (changeFlows.length || twrDaily.length) {
    cashFlows.length = 0;
    cashFlows.push(...changeFlows);
  }

  return {
    nav: {
      accountId,
      accountAlias,
      baseCurrency,
      periodStart: points[0].date,
      periodEnd: points[points.length - 1].date,
      filename,
      points,
    },
    cashFlows,
    twrDaily: twrDaily.length >= 2 ? twrDaily : [],
  };
}
