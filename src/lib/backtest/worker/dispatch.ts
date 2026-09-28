import { ResultAnalytics } from '../analytics';
import type { AnalyticsCall } from './protocol';

export function dispatch(a: ResultAnalytics, call: AnalyticsCall): unknown {
  switch (call.op) {
    case 'periods':
      return a.periods(call.kind);
    case 'overview':
      return a.overview();
    case 'focused':
      return a.focused(call.start, call.end);
    case 'charts':
      return a.charts(call.mode, call.benchmarks, call.maxPoints);
  }
}
