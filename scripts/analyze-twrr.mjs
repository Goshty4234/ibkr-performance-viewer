import { readFileSync } from 'fs';
import { createRequire } from 'module';

// Quick analysis without tsx — duplicate parser logic inline
function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { fields.push(current); current = ''; continue; }
    current += ch;
  }
  fields.push(current);
  return fields.map((f) => f.replace(/^"|"$/g, '').trim());
}

function parseNum(v) {
  if (!v || v === '--') return 0;
  const n = parseFloat(v.replace(/[%,\s"]/g, '').replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : 0;
}

const text = readFileSync('Variation_jour_par_jour.csv', 'utf8');
const lines = text.split(/\r?\n/).filter((l) => l.trim());
const headers = parseCsvLine(lines[0]);
const dateCol = headers.findIndex((h) => h.toLowerCase() === 'reportdate');
const totalCol = headers.findIndex((h) => h.toLowerCase() === 'total');
const cashCol = headers.findIndex((h) => h.toLowerCase() === 'cash');
const stockCol = headers.findIndex((h) => h.toLowerCase() === 'stock');
const optionsCol = headers.findIndex((h) => h.toLowerCase() === 'options');

const byDate = new Map();
for (let i = 1; i < lines.length; i++) {
  const row = parseCsvLine(lines[i]);
  if (!row[0] || row[0] === 'ClientAccountID') continue;
  const raw = row[dateCol];
  const date = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
  byDate.set(date, {
    date,
    total: parseNum(row[totalCol]),
    cash: parseNum(row[cashCol]),
    stock: parseNum(row[stockCol]),
    options: parseNum(row[optionsCol]),
  });
}
const pts = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
console.log('Unique days:', pts.length);
console.log('Range:', pts[0].date, '->', pts.at(-1).date);
console.log('NAV:', pts[0].total.toFixed(0), '->', pts.at(-1).total.toFixed(0));
console.log('Raw return %:', ((pts.at(-1).total / pts[0].total - 1) * 100).toFixed(1));

// Big daily moves
const jumps = [];
for (let i = 1; i < pts.length; i++) {
  const prev = pts[i - 1], cur = pts[i];
  const dNav = cur.total - prev.total;
  const rel = dNav / prev.total;
  const dStock = cur.stock - prev.stock;
  const relStock = prev.stock > 0 ? dStock / prev.stock : 0;
  const dCash = cur.cash - prev.cash;
  const dInv = (cur.stock + cur.options) - (prev.stock + prev.options);
  if (Math.abs(rel) > 0.05) {
    jumps.push({ date: cur.date, rel: (rel * 100).toFixed(1), dNav: dNav.toFixed(0), relStock: (relStock * 100).toFixed(1), dCash: dCash.toFixed(0), dInv: dInv.toFixed(0), residual: (dNav - dInv).toFixed(0) });
  }
}
console.log('\nBig NAV days (>5%):');
for (const j of jumps) console.log(j);

// Exact copy of estimateExternalCashFlow + buildTwrrCurveFromNav
function estimateCF(prev, cur) {
  if (prev.stock == null || cur.stock == null || prev.total <= 0) return 0;
  const dNav = cur.total - prev.total;
  const dInvest = (cur.stock + (cur.options ?? 0)) - (prev.stock + (prev.options ?? 0));
  const relNav = Math.abs(dNav) / prev.total;
  const relStock = prev.stock > 0 ? (cur.stock - prev.stock) / prev.stock : 0;
  if (relNav < 0.02) return 0;
  if (Math.abs(relStock) > 0.35 && relNav > 0.06) return dNav;
  const residual = dNav - dInvest;
  if (Math.abs(residual) > Math.max(500, prev.total * 0.01)) return residual;
  return 0;
}

let idx = 100;
const cfDays = [];
for (let i = 1; i < pts.length; i++) {
  const prev = pts[i - 1], cur = pts[i];
  const cf = estimateCF(prev, cur);
  if (Math.abs(cf) > 500) cfDays.push({ date: cur.date, cf: cf.toFixed(0), dNav: (cur.total - prev.total).toFixed(0) });
  const r = (cur.total - cf) / prev.total - 1;
  idx *= 1 + r;
}
console.log('\nExact heuristic TWRR%:', (idx - 100).toFixed(1));
console.log('CF days detected:', cfDays.length);
for (const d of cfDays) console.log(' ', d);

// Without stock (simulates old DB import)
idx = 100;
for (let i = 1; i < pts.length; i++) {
  const prev = { ...pts[i-1], stock: undefined, options: undefined };
  const cur = { ...pts[i], stock: undefined, options: undefined };
  const cf = estimateCF(prev, cur);
  const r = (cur.total - cf) / prev.total - 1;
  idx *= 1 + r;
}
// Improved heuristic v2
function estimateCFv2(prev, cur) {
  if (prev.stock == null || cur.stock == null || prev.total <= 0) return 0;
  const dNav = cur.total - prev.total;
  const dInvest = (cur.stock + (cur.options ?? 0)) - (prev.stock + (prev.options ?? 0));
  const relNav = Math.abs(dNav) / prev.total;
  if (relNav < 0.02) return 0;

  const investRatio = Math.abs(dNav) > 1 ? Math.abs(dInvest) / Math.abs(dNav) : 0;
  // Capital added/removed and immediately reflected in holdings (deposit+invest or transfer)
  if (relNav > 0.15 && investRatio > 0.85) return dNav;

  const dCash = (cur.cash ?? 0) - (prev.cash ?? 0);
  const cashThreshold = Math.max(500, prev.total * 0.01);
  if (Math.abs(dCash) > cashThreshold && Math.abs(dCash) >= Math.abs(dInvest) * 0.5) return dCash;

  const residual = dNav - dInvest;
  if (Math.abs(residual) > cashThreshold && Math.abs(residual) > Math.abs(dInvest) * 0.25) return residual;

  return 0;
}

idx = 100;
const cfDays2 = [];
for (let i = 1; i < pts.length; i++) {
  const prev = pts[i - 1], cur = pts[i];
  const cf = estimateCFv2(prev, cur);
  if (Math.abs(cf) > 500) cfDays2.push({ date: cur.date, cf: cf.toFixed(0), dNav: (cur.total - prev.total).toFixed(0) });
  const r = (cur.total - cf) / prev.total - 1;
  idx *= 1 + r;
}
console.log('\nImproved heuristic TWRR%:', (idx - 100).toFixed(1));
console.log('CF days:', cfDays2.length);
for (const d of cfDays2) console.log(' ', d);

// Subperiod Jul-Dec 2025
const sub = pts.filter(p => p.date >= '2025-07-08' && p.date <= '2025-12-02');
idx = 100;
for (let i = 1; i < sub.length; i++) {
  const cf = estimateCFv2(sub[i-1], sub[i]);
  const r = (sub[i].total - cf) / sub[i-1].total - 1;
  idx *= 1 + r;
}
console.log('\nJul-Dec 2025 TWRR% (compare stmt 19.58%):', (idx - 100).toFixed(1));


