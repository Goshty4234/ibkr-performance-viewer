import type { CashFlow } from './types';
import {
  headerIndex,
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

/** Flex Query Cash Transactions export (tabular CSV) */
export function isFlexCashCsv(text: string): boolean {
  if (!text.includes('FXRateToBase') || !text.includes('AssetClass')) return false;
  const first = text.split(/\r?\n/).find((l) => l.trim());
  if (!first) return false;
  if (first.startsWith('Statement,')) return false;
  const lower = first.toLowerCase();
  const isNavOnly = lower.includes('reportdate') && lower.includes('total') && lower.includes('stock');
  if (isNavOnly && text.toLowerCase().includes('fxratetobase')) {
    return false;
  }
  return lower.includes('amount');
}

export function parseFlexCashCsv(text: string, filename: string): CashFlow[] {
  const cashSections = scanFlexSections(text).filter((s) => s.kind === 'cash');
  if (!cashSections.length) {
    throw new Error(
      `Format Flex Cash Transactions non reconnu dans ${filename} — colonnes Date et Amount attendues`,
    );
  }

  const flows: CashFlow[] = [];

  for (const section of cashSections) {
    const headers = section.headers;
    const dateCol = headerIndex(headers, 'settledate', 'reportdate', 'date/time');
    const amountCol = headers.findIndex((h) => h.toLowerCase() === 'amount');
    const typeCol = headerIndex(headers, 'type');
    const descCol = headerIndex(headers, 'description');
    const fxCol = headers.findIndex((h) => h.toLowerCase() === 'fxratetobase');

    if (dateCol < 0 || amountCol < 0) {
      throw new Error(`Colonnes Date/Amount introuvables dans ${filename}`);
    }

    for (const row of section.rows) {
      const type = typeCol >= 0 ? row[typeCol] ?? '' : '';
      const description = descCol >= 0 ? row[descCol] ?? '' : '';
      if (!isTwrrCashType(type, description)) continue;

      const rawAmount = parseNumber(row[amountCol]);
      if (!rawAmount) continue;

      const fx = fxCol >= 0 ? parseNumber(row[fxCol]) : 1;
      const amount = fx > 0 && fx !== 1 ? rawAmount * fx : rawAmount;

      flows.push({
        date: parseReportDate(row[dateCol]),
        amount,
        description: description || type,
        isExternal: true,
      });
    }
  }

  if (!flows.length) {
    throw new Error(`Aucun dépôt/retrait/transfert trouvé dans ${filename}`);
  }

  return flows;
}

export function cashFlowsToDateMap(flows: CashFlow[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const cf of flows) {
    map.set(cf.date, (map.get(cf.date) ?? 0) + cf.amount);
  }
  return map;
}
