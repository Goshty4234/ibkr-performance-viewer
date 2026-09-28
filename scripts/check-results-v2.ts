/**
 * Checks the browser-side result pipeline against a running engine:
 *   npx tsx scripts/check-results-v2.ts [http://127.0.0.1:8765]
 */
import { buildResultSeries, prepareCharts } from '../src/lib/backtest/chart-data';
import { okSummaries, portfolioDates, toBundle } from '../src/lib/backtest/result-data';
import type { EngineJob, PortfolioDetail, ResultSummary } from '../src/lib/engine/types';

const BASE = process.argv[2] ?? 'http://127.0.0.1:8765';

async function main() {
  const jobs = (await (await fetch(`${BASE}/jobs`)).json()) as EngineJob[];
  const done = jobs.find((j) => j.status === 'done');
  if (!done) throw new Error('no finished job on the engine');
  const t0 = performance.now();
  const summaryText = await (await fetch(`${BASE}/jobs/${done.id}/summary`)).text();
  const summary = toBundle(JSON.parse(summaryText)).summary as ResultSummary;
  const t1 = performance.now();
  const { dates, series } = buildResultSeries(summary, 'no_additions', Object.keys(summary.benchmarks));
  const charts = prepareCharts(dates, series);
  const t2 = performance.now();
  console.log(`job ${done.id.slice(0, 6)}: summary ${(summaryText.length / 1e6).toFixed(2)} MB json, parse ${(t1 - t0).toFixed(0)} ms, charts ${(t2 - t1).toFixed(0)} ms`);
  console.log(`axis ${summary.dates.length} dates, chart axis ${dates.length}, sampled ${charts.pctData.length} points, ${series.length} series`);
  let bad = 0;
  for (const p of okSummaries(summary)) {
    const d = portfolioDates(summary, p);
    const last = p.series.with_additions[p.series.with_additions.length - 1] ?? NaN;
    const finalStat = p.stats['Final Value (with)'] ?? NaN;
    const ok = d.length === p.series.with_additions.length && Math.abs(last - finalStat) < 0.01;
    if (!ok) bad++;
    console.log(`  ${ok ? 'OK ' : 'BAD'} ${p.name}: ${d[0]} -> ${d[d.length - 1]} (${d.length}), last ${last} vs stat ${finalStat.toFixed(2)}, CAGR ${p.stats_display.CAGR}`);
  }
  const first = okSummaries(summary)[0];
  const detail = (await (await fetch(`${BASE}/jobs/${done.id}/portfolio/${first.index}`)).json()) as PortfolioDetail;
  console.log(`detail ${first.name}: ${detail.allocations?.dates.length} allocation dates, ${Object.keys(detail.allocations?.weights ?? {}).length} tickers, ${detail.metrics?.date_idx.length} metric rows`);
  if (bad) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
