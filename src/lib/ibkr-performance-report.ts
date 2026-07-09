import { parseCsvLine } from './flex-csv';
import type { DailyTwrPoint, ParsedStatement } from './types';

function parseIbkrDisplayDate(value: string): string {
  const d = new Date(value.trim().replace(/"/g, ''));
  if (Number.isNaN(d.getTime())) throw new Error(`Date invalide: ${value}`);
  return d.toISOString().slice(0, 10);
}

function parseShortDate(value: string): string {
  const [m, d, yRaw] = value.trim().split('/');
  const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function parseAnalysisPeriod(value: string): { start: string; end: string } {
  const clean = value.replace(/\(Daily\)/i, '').trim();
  const match = clean.match(/^(.+?)\s+(?:to|-)\s+(.+)$/i);
  if (!match) throw new Error(`Période invalide: ${value}`);
  return {
    start: parseIbkrDisplayDate(match[1].trim()),
    end: parseIbkrDisplayDate(match[2].trim()),
  };
}

export function isIbkrPerformanceReportCsv(text: string): boolean {
  return (
    text.includes('Time Period Benchmark Comparison') &&
    text.includes('Introduction,Header,Name,Account') &&
    text.includes(',TWR')
  );
}

export function parseIbkrPerformanceReportCsv(
  text: string,
  filename: string,
): ParsedStatement {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  let accountId = '';
  let accountAlias = '';
  let baseCurrency = 'CAD';
  let periodStart = '';
  let periodEnd = '';
  let returnCol = -1;

  for (const line of lines) {
    const row = parseCsvLine(line);
    if (row[0] === 'Introduction' && row[1] === 'Data') {
      accountAlias = row[2] ?? '';
      accountId = row[3] ?? '';
      baseCurrency = row[5] || 'CAD';
      if (row[7]) {
        const period = parseAnalysisPeriod(row[7]);
        periodStart = period.start;
        periodEnd = period.end;
      }
    }
    if (row[0] === 'Time Period Benchmark Comparison' && row[1] === 'Header') {
      for (let i = 2; i < row.length; i++) {
        if (row[i]?.endsWith('Return') && i > 0) {
          returnCol = i;
          if (!accountId) accountId = row[i - 1] ?? '';
        }
      }
    }
    if (row[0] === 'Time Period Benchmark Comparison' && row[1] === 'MetaInfo' && row[2] === 'Analysis Period') {
      const period = parseAnalysisPeriod(row[3]);
      periodStart = period.start;
      periodEnd = period.end;
    }
  }

  if (!accountId || returnCol < 0) {
    throw new Error(`Rapport performance IBKR non reconnu dans ${filename}`);
  }

  const twrDaily: DailyTwrPoint[] = [];
  for (const line of lines) {
    const row = parseCsvLine(line);
    if (row[0] !== 'Time Period Benchmark Comparison' || row[1] !== 'Data') continue;
    const rawDate = row[2];
    const ret = parseFloat(row[returnCol]);
    if (!rawDate || Number.isNaN(ret)) continue;
    twrDaily.push({ date: parseShortDate(rawDate), returnPct: ret });
  }

  if (twrDaily.length < 2) {
    throw new Error(`Aucun rendement TWR quotidien dans ${filename}`);
  }

  twrDaily.sort((a, b) => a.date.localeCompare(b.date));
  if (!periodStart) periodStart = twrDaily[0].date;
  if (!periodEnd) periodEnd = twrDaily[twrDaily.length - 1].date;

  let idx = 100;
  for (const p of twrDaily) {
    idx *= 1 + p.returnPct / 100;
  }
  const twrr = idx / 100 - 1;

  return {
    accountId,
    accountAlias,
    baseCurrency,
    periodStart,
    periodEnd,
    startingNav: 0,
    endingNav: 0,
    twrr,
    filename,
    cashFlows: [],
    dailyEvents: [],
    twrDaily,
  };
}
