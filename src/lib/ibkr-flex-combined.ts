import type { CashFlow, DailyNavPoint, ParsedNavSeries } from './types';
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
): { nav: ParsedNavSeries; cashFlows: CashFlow[] } {
  const sections = scanFlexSections(text);
  const navSections = sections.filter((s) => s.kind === 'nav');
  const cashSections = sections.filter((s) => s.kind === 'cash');

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
    const typeCol = headerIndex(headers, 'type');
    const descCol = headerIndex(headers, 'description');
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
  };
}
