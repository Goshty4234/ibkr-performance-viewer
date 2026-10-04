import type { ResultSummary } from '@/lib/engine/types';

export type AnalyticsCall =
  | { op: 'periods'; kind: 'year' | 'month' }
  | { op: 'overview' }
  | { op: 'focused'; start: string; end: string }
  | { op: 'charts'; mode: 'no_additions' | 'with_additions'; benchmarks: string[]; maxPoints?: number }
  | { op: 'rangeCharts'; mode: 'no_additions' | 'with_additions'; benchmarks: string[]; start: string; end: string; maxPoints?: number };

export type WorkerRequest =
  | { id: number; type: 'load'; key: string; summary: ResultSummary }
  | { id: number; type: 'drop'; key: string }
  | { id: number; type: 'call'; key: string; call: AnalyticsCall };

export type WorkerResponse = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
