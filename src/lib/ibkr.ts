import type { CashFlow, DailyEvent, ParsedStatement } from './types';

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

function parseIbkrDateTime(value: string): string {
  const iso = value.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return fmtDate(parseIbkrDate(value));
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


function isTotalRow(label: string | undefined): boolean {
  if (!label) return true;
  const l = label.toLowerCase();
  return l === 'total' || l.includes('total in');
}

function headerIndex(headers: string[], ...needles: string[]): number {
  const lower = headers.map((h) => h.toLowerCase());
  for (const needle of needles) {
    const idx = lower.findIndex((h) => h.includes(needle.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

function addDailyEvent(events: DailyEvent[], date: string, amount: number, category: DailyEvent['category']) {
  if (!date || !amount) return;
  events.push({ date, amount, category });
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
  const dailyEvents: DailyEvent[] = [];

  let section = '';
  let inTwrrSection = false;
  let navHeaderFields: string[] = [];
  let tradesHeader: string[] = [];

  for (const row of rows) {
    const [sec, type, ...rest] = row;
    if (!sec) continue;
    if (sec !== section) {
      section = sec;
      inTwrrSection = false;
      navHeaderFields = [];
      tradesHeader = [];
    }

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
      const [currency, dateStr, description, amountStr] = rest;
      if (!currency || isTotalRow(currency) || !dateStr || !amountStr) continue;
      if (currency !== baseCurrency) continue;
      const desc = description ?? '';
      // Securities ATON are captured in Transfers — skip cash duplicate
      if (desc.toLowerCase().includes('aton transfer')) continue;
      // All deposits/withdrawals (incl. internal) affect per-account TWRR
      cashFlows.push({
        date: fmtDate(parseIbkrDate(dateStr)),
        amount: parseNumber(amountStr),
        description: desc,
        isExternal: true,
      });
    }
    if (sec === 'Transfers' && type === 'Data' && !isTotalRow(rest[0])) {
      const currency = rest[1];
      const dateStr = rest[3];
      const xferType = rest[4];
      const direction = rest[5];
      const marketValue = parseNumber(rest[10]);
      if (!dateStr || !marketValue || currency !== baseCurrency) continue;
      const signed = direction === 'Out' ? -Math.abs(marketValue) : Math.abs(marketValue);
      cashFlows.push({
        date: fmtDate(parseIbkrDate(dateStr)),
        amount: signed,
        description: `Transfert ${xferType} ${direction} — ${rest[2] ?? ''}`.trim(),
        isExternal: true,
      });
    }
    if (sec === 'Trades') {
      if (type === 'Header') tradesHeader = rest;
      if (type === 'Data' && rest[0] === 'Order' && tradesHeader.length) {
        const dateIdx = headerIndex(tradesHeader, 'date/time', 'date');
        const mtmIdx = headerIndex(tradesHeader, 'mtm');
        const dateStr = dateIdx >= 0 ? rest[dateIdx] : '';
        if (!dateStr) continue;
        const date = parseIbkrDateTime(dateStr);
        const mtm = mtmIdx >= 0 ? parseNumber(rest[mtmIdx]) : 0;
        addDailyEvent(dailyEvents, date, mtm, 'trade');
      }
    }
    if (sec === 'Dividends' && type === 'Data' && !isTotalRow(rest[0])) {
      const dateStr = rest[1];
      const amount = parseNumber(rest[3]);
      if (dateStr && amount) {
        addDailyEvent(dailyEvents, fmtDate(parseIbkrDate(dateStr)), amount, 'dividend');
      }
    }
    if (sec === 'Interest' && type === 'Data' && !isTotalRow(rest[0])) {
      const dateStr = rest[1];
      const amount = parseNumber(rest[3]);
      if (dateStr && amount) {
        addDailyEvent(dailyEvents, fmtDate(parseIbkrDate(dateStr)), amount, 'interest');
      }
    }
    if (sec === 'Withholding Tax' && type === 'Data' && !isTotalRow(rest[0])) {
      const dateStr = rest[1];
      const amount = parseNumber(rest[3]);
      if (dateStr && amount) {
        addDailyEvent(dailyEvents, fmtDate(parseIbkrDate(dateStr)), amount, 'tax');
      }
    }
    if (sec === 'Fees' && type === 'Data' && !isTotalRow(rest[0]) && rest[2]) {
      const dateStr = rest[2];
      const amount = parseNumber(rest[4]);
      if (dateStr && amount) {
        addDailyEvent(dailyEvents, fmtDate(parseIbkrDate(dateStr)), amount, 'fee');
      }
    }
    if (sec === 'Commission Adjustments' && type === 'Data' && !isTotalRow(rest[0])) {
      const dateStr = rest[1];
      const amount = parseNumber(rest[3]);
      if (dateStr && amount) {
        addDailyEvent(dailyEvents, fmtDate(parseIbkrDate(dateStr)), amount, 'fee');
      }
    }
    if (sec === 'Corporate Actions' && type === 'Data' && !isTotalRow(rest[0])) {
      const dateStr = rest[2] || rest[1];
      const amount = parseNumber(rest[7]) || parseNumber(rest[6]);
      if (dateStr && amount) {
        addDailyEvent(dailyEvents, parseIbkrDateTime(dateStr), amount, 'corporate');
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
    dailyEvents,
  };
}
