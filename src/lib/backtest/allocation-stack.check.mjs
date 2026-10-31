/**
 * The chart used to keep only the 16 names with the highest peak and paint
 * everyone else as one grey band. A day that holds 20 other names must keep
 * each of them, and those weights must add up to the whole portfolio.
 */
import { buildAllocationView } from './allocation-stack.ts';

const names = [];
for (let i = 0; i < 16; i++) names.push(`PEAK${i}`);
for (let i = 0; i < 20; i++) names.push(`HELD${i}`);

const dates = [];
const weights = Object.fromEntries(names.map((t) => [t, []]));
for (let d = 0; d < 60; d++) {
  dates.push(`2000-01-${String(d + 1).padStart(2, '0')}`);
  for (const t of names) {
    if (t.startsWith('PEAK') && d < 20) weights[t].push(1 / 16);
    else if (t.startsWith('HELD') && d >= 20) weights[t].push(0.05);
    else weights[t].push(0);
  }
}

const view = buildAllocationView({ dates, weights, factor: 100 }, '', '');
const day = view.paint.find((row) => row.date === '2000-01-40');
if (!day) throw new Error('missing sample for the day that holds 20 names');

const held = names.filter((t) => t.startsWith('HELD'));
const missing = held.filter((t) => !view.keys.includes(t));
if (missing.length) throw new Error(`dropped ${missing.join(', ')}`);
if (view.keys.includes('Autres')) throw new Error('still folding names into Autres');

let sum = 0;
for (const t of held) {
  const v = Number(day[t]);
  if (Math.abs(v - 5) > 0.01) throw new Error(`${t} painted ${v}, expected 5`);
  sum += v;
}
const peaks = names.filter((t) => t.startsWith('PEAK')).reduce((s, t) => s + Number(day[t]), 0);
if (peaks !== 0) throw new Error(`peak names still take ${peaks}% on a day they are not held`);
if (Math.abs(sum - 100) > 0.05) throw new Error(`held names sum to ${sum}, expected 100`);

console.log(`ok ${view.keys.length} bands, held day sums to ${sum.toFixed(2)}%`);
