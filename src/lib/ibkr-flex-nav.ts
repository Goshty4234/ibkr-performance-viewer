import type { DailyNavPoint, ParsedNavSeries } from './types';
import {
  isNavReportDate,
  parseNumber,
  parseReportDate,
  scanFlexSections,
} from './flex-csv';

/** Flex Query NAV export (ReportDate + Total columns) */
export function isFlexNavCsv(text: string): boolean {
  const first = text.split(/\r?\n/).find((l) => l.trim());
  if (!first) return false;
  if (first.startsWith('Statement,')) return false;
  const lower = first.toLowerCase();
  return lower.includes('reportdate') && lower.includes('total');
}

export function parseFlexNavCsv(text: string, filename: string): ParsedNavSeries {
  const navSections = scanFlexSections(text).filter((s) => s.kind === 'nav');
  if (!navSections.length) {
    throw new Error(
      `Format Flex NAV non reconnu dans ${filename} — colonnes ReportDate et Total attendues`,
    );
  }

  const byDate = new Map<string, DailyNavPoint>();
  let accountId = '';
  let accountAlias = '';
  let baseCurrency = 'USD';

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

    if (dateCol < 0 || totalCol < 0) {
      throw new Error(`Colonnes ReportDate/Total introuvables dans ${filename}`);
    }

    for (const row of section.rows) {
      const rawAccount = accountCol >= 0 ? row[accountCol] : '';
      if (!rawAccount || rawAccount === 'ClientAccountID') continue;

      const rawDate = row[dateCol];
      if (!isNavReportDate(rawDate)) continue;

      if (!accountId) {
        accountId = rawAccount;
        accountAlias = aliasCol >= 0 ? row[aliasCol] ?? '' : '';
        baseCurrency = currencyCol >= 0 ? row[currencyCol] || 'USD' : 'USD';
      } else if (rawAccount !== accountId) {
        throw new Error(`Plusieurs comptes dans ${filename} — un seul compte par import`);
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
  if (!points.length) {
    throw new Error(`Aucune NAV quotidienne trouvée dans ${filename}`);
  }
  if (!accountId) {
    throw new Error(`Compte IBKR introuvable dans ${filename}`);
  }

  return {
    accountId,
    accountAlias,
    baseCurrency,
    periodStart: points[0].date,
    periodEnd: points[points.length - 1].date,
    filename,
    points,
  };
}
