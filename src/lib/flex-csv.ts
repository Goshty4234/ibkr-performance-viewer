export function parseCsvLine(line: string): string[] {
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
  return fields.map((f) => f.replace(/^"|"$/g, '').trim());
}

export function parseReportDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Date invalide: ${raw}`);
}

export function isNavReportDate(raw: string): boolean {
  const s = raw.trim();
  return /^\d{8}$/.test(s) || /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function parseNumber(value: string): number {
  if (!value || value === '--') return 0;
  const cleaned = value.replace(/[%,\s"]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function headerIndex(headers: string[], ...needles: string[]): number {
  const lower = headers.map((h) => h.toLowerCase());
  for (const needle of needles) {
    const idx = lower.findIndex((h) => h.includes(needle.toLowerCase()));
    if (idx >= 0) return idx;
  }
  return -1;
}

export type FlexSectionKind = 'nav' | 'cash' | 'transfer' | 'changeNav' | 'positions' | 'trades' | 'taxes';

export interface FlexSection {
  kind: FlexSectionKind;
  headers: string[];
  rows: string[][];
}

export function classifyFlexHeader(headers: string[]): FlexSectionKind | null {
  const lower = headers.map((h) => h.toLowerCase());
  if (lower.includes('fxratetobase') && lower.includes('amount') && lower.includes('assetclass')) {
    return 'cash';
  }
  if (lower.includes('reportdate') && lower.includes('total') && lower.includes('stock')) {
    return 'nav';
  }
  // Change in NAV, one row per day: IBKR's own daily TWR plus every deposit/withdrawal/asset transfer.
  if (lower.includes('todate') && lower.includes('endingvalue') && lower.includes('twr')) {
    return 'changeNav';
  }
  // Transfers (ACATS / FOP / internal): shares moving in or out of the account with no cash leg.
  if (lower.includes('direction') && (lower.includes('positionamountinbase') || lower.includes('positionamount'))) {
    return 'transfer';
  }
  // Open Positions: one row per position (and per lot) at the end of each day.
  if (lower.includes('positionvalue') && lower.includes('quantity') && lower.includes('markprice')) {
    return 'positions';
  }
  // Trades: executions, orders and summaries.
  if (lower.includes('tradeprice') && lower.includes('ibcommission')) {
    return 'trades';
  }
  // Transaction Taxes (financial transaction taxes charged on trades).
  if (lower.includes('taxamount') && lower.includes('taxdescription')) {
    return 'taxes';
  }
  return null;
}

/** IBKR alternates NAV + Cash Transactions header blocks in one CSV */
export function scanFlexSections(text: string): FlexSection[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const sections: FlexSection[] = [];
  let current: FlexSection | null = null;

  for (const line of lines) {
    if (!line.startsWith('"ClientAccountID"') && !line.startsWith('ClientAccountID')) {
      if (current && /^"?U\d/.test(line)) {
        current.rows.push(parseCsvLine(line));
      }
      continue;
    }

    const headers = parseCsvLine(line);
    const kind = classifyFlexHeader(headers);

    if (current) sections.push(current);
    // An unrecognised section must not leak its rows into the previous one.
    current = kind ? { kind, headers, rows: [] } : null;
  }

  if (current) sections.push(current);
  return sections;
}

export function isFlexCombinedCsv(text: string): boolean {
  const kinds = new Set(scanFlexSections(text).map((s) => s.kind));
  return kinds.has('nav') && (kinds.has('cash') || kinds.has('changeNav') || kinds.has('transfer'));
}
