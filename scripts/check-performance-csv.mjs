import { readFileSync } from 'fs';
import { parseIbkrCsv } from '../src/lib/ibkr.ts';

const file = 'Nicolas_Cool_U16150944_December_02_2024_July_08_2026.csv';
const text = readFileSync(file, 'utf8');

try {
  const p = parseIbkrCsv(text, file);
  console.log('Activity Statement parse OK:', p.periodStart, p.periodEnd, (p.twrr * 100).toFixed(2) + '%');
} catch (e) {
  console.log('Activity Statement parser:', e.message);
}

function parseLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(current); current = ''; continue; }
    current += ch;
  }
  fields.push(current);
  return fields;
}

function toIso(date) {
  const [m, d, yRaw] = date.split('/');
  const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

const pts = [];
for (const line of text.split(/\r?\n/).filter(Boolean)) {
  const r = parseLine(line);
  if (r[0] !== 'Time Period Benchmark Comparison' || r[1] !== 'Data') continue;
  const ret = parseFloat(r[6]);
  if (!r[2] || Number.isNaN(ret)) continue;
  pts.push({ date: toIso(r[2]), ret });
}

let idx = 100;
const curve = pts.map((p) => {
  idx *= 1 + p.ret / 100;
  return { date: p.date, portfolio: idx - 100 };
});

console.log('\nPerformance report (IBKR daily TWR):');
console.log('Days:', pts.length, pts[0]?.date, '->', pts.at(-1)?.date);
console.log('Full period TWR%:', curve.at(-1)?.portfolio.toFixed(2));

function periodTwrr(start, end) {
  let i = 100;
  for (const p of pts) {
    if (p.date < start || p.date > end) continue;
    i *= 1 + p.ret / 100;
  }
  return i - 100;
}

console.log('Dec24-Dec25:', periodTwrr('2024-12-02', '2025-12-02').toFixed(2) + '%');
console.log('Jul-Dec 2025:', periodTwrr('2025-07-08', '2025-12-02').toFixed(2) + '%');
console.log('Jul 2025 -> end:', periodTwrr('2025-07-08', '2026-07-08').toFixed(2) + '%');
