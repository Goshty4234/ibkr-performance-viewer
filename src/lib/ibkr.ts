import type { CashFlow, ParsedStatement } from './types';

function parseNumber(value: string | undefined): number {
  if (!value || value === '--') return 0;
  const cleaned = value.replace(/[%,\s"]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function parseIbkrDate(value: string): Date {
  const trimmed = value.trim().replace(/"/g, '');
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Date invalide: ${value}`);
  return parsed;
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parsePeriod(value: string): { start: Date; end: Date } {
  const match = value.match(/^(.+?)\s*-\s*(.+)$/);
  if (!match) throw new Error(`Période invalide: ${value}`);
  return { start: parseIbkrDate(match[1]), end: parseIbkrDate(match[2]) };
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(current); current = ''; continue; }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function isExternalCashFlow(description: string): boolean {
  return !description.toLowerCase().includes('internal transfer');
}

export function parseIbkrCsv(text: string, filename: string): ParsedStatement {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = lines.map(parseCsvLine);

  let periodStart: Date | null = null;
  let periodEnd: Date | null = null;
  let accountId = '';
  let accountAlias = '';
  let baseCurrency = 'USD';
  let startingNav = 0;
  let endingNav = 0;
  let twrr = 0;
  const cashFlows: CashFlow[] = [];

  let section = '';
  let inTwrrSection = false;
  let navHeaderFields: string[] = [];

  for (const row of rows) {
    const [sec, type, ...rest] = row;
    if (!sec) continue;
    if (sec !== section) { section = sec; inTwrrSection = false; navHeaderFields = []; }

    if (sec === 'Statement' && type === 'Data' && rest[0] === 'Period') {
      const period = parsePeriod(rest.slice(1).join(','));
      periodStart = period.start;
      periodEnd = period.end;
    }
    if (sec === 'Account Information' && type === 'Data') {
      if (rest[0] === 'Account') accountId = rest[1] ?? '';
      if (rest[0] === 'Account Alias') accountAlias = rest[1] ?? '';
      if (rest[0] === 'Base Currency') baseCurrency = rest[1] ?? 'USD';
    }
    if (sec === 'Net Asset Value') {
      if (type === 'Header') {
        inTwrrSection = rest[0] === 'Time Weighted Rate of Return';
        if (!inTwrrSection) navHeaderFields = rest;
      }
      if (type === 'Data') {
        if (inTwrrSection) twrr = parseNumber(rest[0]) / 100;
        else if (rest[0]?.trim() === 'Total') {
          const pi = navHeaderFields.findIndex((h) => h.toLowerCase().includes('prior'));
          const ci = navHeaderFields.findIndex((h) => h.toLowerCase().includes('current total'));
          if (pi >= 0) startingNav = parseNumber(rest[pi]);
          if (ci >= 0) endingNav = parseNumber(rest[ci]);
        }
      }
    }
    if (sec === 'Change in NAV' && type === 'Data') {
      if (rest[0] === 'Starting Value') startingNav = parseNumber(rest[1]);
      if (rest[0] === 'Ending Value') endingNav = parseNumber(rest[1]);
    }
    if (sec === 'Deposits & Withdrawals' && type === 'Data') {
      const [, dateStr, description, amountStr] = rest;
      if (dateStr && amountStr) {
        cashFlows.push({
          date: fmtDate(parseIbkrDate(dateStr)),
          amount: parseNum(amountStr),
          description: description ?? '',
          isExternal: isExternalCashFlow(description ?? ''),
        });
      }
    }
    if (sec === 'Transfers' && type === 'Data' && rest[0] !== 'Total' && rest[0] !== 'Total in CAD') {
      if (rest[2] === 'ATON' && rest[3] === 'In' && rest[1]) {
        const mv = parseNumber((rest[9] ?? '').replace(/,/g, ''));
        if (mv) cashFlows.push({ date: fmtDate(parseIbkrDate(rest[1])), amount: Math.abs(mv), description: 'Transfert entrant (ATON)', isExternal: true });
      }
    }
  }

  if (!periodStart || !periodEnd) throw new Error(`Période introuvable dans ${filename}`);
  if (!accountId) throw new Error(`Compte introuvable dans ${filename}`);

  return {
    accountId,
    accountAlias,
    baseCurrency,
    periodStart: fmtDate(periodStart),
    periodEnd: fmtDate(periodEnd),
    startingNav,
    endingNav,
    twrr,
    filename,
    cashFlows,
  };
}

function parseNum(v: string) { return parseNumber(v); }
