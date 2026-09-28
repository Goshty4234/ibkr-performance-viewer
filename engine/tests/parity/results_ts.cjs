// Runs the compiled TypeScript analytics on a result bundle (see results_parity.py).
// usage: node results_ts.cjs <compiled analytics dir> <bundle.json.gz> <start> <end> <out.json>
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const [dir, bundlePath, start, end, outPath] = process.argv.slice(2);
const load = (m) => require(path.join(dir, m));
const S = load('series.js');
const P = load('periods.js');
const F = load('focused.js');
const O = load('overview.js');

let obj = JSON.parse(zlib.gunzipSync(fs.readFileSync(bundlePath)).toString('utf8'));
const summary = obj.summary || obj;
const pfs = S.decodePortfolios(summary);
const benchCache = new Map();
const bench = (t) => {
  if (!benchCache.has(t)) benchCache.set(t, S.decodeBenchReturns(summary, t));
  return benchCache.get(t);
};
const firstBench = (summary.portfolios[0] && summary.portfolios[0].config && summary.portfolios[0].config.benchmark_ticker) || '^GSPC';

const num = (v) => (Number.isNaN(v) ? null : v === Infinity ? 'inf' : v);
const arr = (a) => Array.from(a, num);
const rowObj = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'index' && k !== 'name').map(([k, v]) => [k, num(v)]));

const t0 = performance.now();
const out = { periods: {}, timings: {} };
for (const kind of ['year', 'month']) {
  const table = P.periodTable(pfs, kind);
  const robust = P.robustStats(table, pfs, bench(firstBench));
  out.periods[kind] = {
    labels: table.labels,
    table: Object.fromEntries(table.columns.map((c) => [c.name, { pct: arr(c.pct), final: arr(c.final) }])),
    robust: Object.fromEntries(robust.map((r) => [r.name, rowObj(r)])),
  };
}
out.timings.periods_ms = performance.now() - t0;
const t1 = performance.now();
out.variation = Object.fromEntries(O.variationSummary(pfs).map((r) => [r.name, {
  'Total Return': num(r.totalReturn), CAGR: num(r.cagr), Volatility: num(r.volatility), 'Max Drawdown': num(r.maxDrawdown),
}]));
const hm = O.monthlyHeatmap(pfs);
const cells = {};
for (const [mi, ri, v] of hm.cells) {
  const name = hm.rows[ri].name;
  (cells[name] = cells[name] || {})[hm.months[mi]] = v;
}
out.heatmap = { months: hm.months, cells };
out.timings.overview_ms = performance.now() - t1;
const t2 = performance.now();
out.focused = {};
for (const [s, e] of [[start, end], ['1900-01-01', '2100-12-31']]) {
  out.focused[`${s}:${e}`] = Object.fromEntries(F.focusedAnalysis(pfs, bench, s, e).map((r) => [r.name, rowObj(r)]));
}
out.timings.focused_ms = performance.now() - t2;
fs.writeFileSync(outPath, JSON.stringify(out));
