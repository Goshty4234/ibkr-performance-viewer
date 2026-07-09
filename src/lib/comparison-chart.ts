import type { BenchmarkSymbol } from './types';
import { effectiveSeriesStart } from './analysis-lock';
import {
  accountSeriesId,
  alignBenchmarkToDates,
  alignCurvePointsToDates,
  benchmarkSeriesId,
  buildMultiSeriesChart,
  primarySeriesId,
  type MultiSeriesChartPoint,
} from './chart-series';
import {
  resolveComparisonChartStart,
  trimAndRebaseCurve,
  unionDates,
  type CurvePoint,
} from './curve-gaps';
import {
  accountCurveDataStart,
  buildAccountPortfolioCurve,
  fetchAccountCurveBundle,
  type AccountCurveBundle,
} from './portfolio-curve';
import { fetchBenchmark } from './performance';

export interface ComparisonChartBuildInput {
  primaryAccountId: string;
  primaryBundle: AccountCurveBundle;
  comparisonAccountIds: string[];
  comparisonBenchmarks: BenchmarkSymbol[];
  rangeStart: string;
  rangeEnd: string;
  /** Verrou par portfolioAccountId (analysisStartLock). */
  accountLocksById?: Map<string, string | null>;
  globalLock?: string | null;
}

function buildSeriesRaw(
  bundle: AccountCurveBundle,
  accountId: string,
  rangeStart: string,
  rangeEnd: string,
  accountLocksById: Map<string, string | null>,
  globalLock: string | null,
): CurvePoint[] {
  const floor = effectiveSeriesStart(
    rangeStart,
    accountLocksById.get(accountId) ?? null,
    globalLock,
  );
  return buildAccountPortfolioCurve(bundle, floor, rangeEnd);
}

export async function buildComparisonChartData(
  input: ComparisonChartBuildInput,
): Promise<MultiSeriesChartPoint[]> {
  const {
    primaryAccountId,
    primaryBundle,
    comparisonAccountIds,
    comparisonBenchmarks,
    rangeStart,
    rangeEnd,
    accountLocksById = new Map(),
    globalLock = null,
  } = input;

  const primaryRaw = buildSeriesRaw(
    primaryBundle,
    primaryAccountId,
    rangeStart,
    rangeEnd,
    accountLocksById,
    globalLock,
  );
  if (primaryRaw.length < 2) return [];

  const comparisonCurves: { id: string; curve: CurvePoint[] }[] = [];
  for (const accId of comparisonAccountIds) {
    const bundle = await fetchAccountCurveBundle(accId);
    const raw = buildSeriesRaw(
      bundle,
      accId,
      rangeStart,
      rangeEnd,
      accountLocksById,
      globalLock,
    );
    if (raw.length) {
      comparisonCurves.push({ id: accountSeriesId(accId), curve: raw });
    }
  }

  const chartStart = resolveComparisonChartStart(rangeStart, [
    primaryRaw,
    ...comparisonCurves.map((c) => c.curve),
  ]);

  const primary = trimAndRebaseCurve(primaryRaw, chartStart);
  const compTrimmed = comparisonCurves.map((c) => ({
    id: c.id,
    curve: trimAndRebaseCurve(c.curve, chartStart),
  }));

  const dates = unionDates([
    primary,
    ...compTrimmed.map((c) => c.curve),
  ]).filter((d) => d >= chartStart && d <= rangeEnd);

  if (dates.length < 2) return [];

  const aligned: { id: string; values: (number | null)[]; gaps: boolean[] }[] = [
    (() => {
      const { values, gaps } = alignCurvePointsToDates(dates, primary);
      return { id: primarySeriesId(), values, gaps };
    })(),
    ...compTrimmed.map((c) => {
      const { values, gaps } = alignCurvePointsToDates(dates, c.curve);
      return { id: c.id, values, gaps };
    }),
  ];

  for (const sym of comparisonBenchmarks) {
    const prices = await fetchBenchmark(sym, chartStart, rangeEnd);
    aligned.push({
      id: benchmarkSeriesId(sym),
      values: alignBenchmarkToDates(dates, prices),
      gaps: dates.map(() => false),
    });
  }

  return buildMultiSeriesChart(dates, aligned);
}

export function comparisonChartStartHint(
  primaryCurve: CurvePoint[],
  comparisonIds: string[],
  comparisonStarts: Map<string, string | null>,
): string | null {
  if (!comparisonIds.length) return null;
  const primaryStart = accountCurveDataStart(primaryCurve);
  let latest = primaryStart;
  for (const id of comparisonIds) {
    const s = comparisonStarts.get(id);
    if (s && (!latest || s > latest)) latest = s;
  }
  if (!latest || !primaryStart || latest <= primaryStart) return null;
  return latest;
}
