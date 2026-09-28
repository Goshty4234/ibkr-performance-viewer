'use client';

import { useEffect, useState } from 'react';
import type { LoadedResult } from '../result-data';
import { analyticsClient } from './client';
import type { AnalyticsCall } from './protocol';

export interface AnalyticsState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Result of one analytics call, computed in the results worker. `call = null` skips. */
export function useAnalytics<T>(result: LoadedResult | null, call: AnalyticsCall | null): AnalyticsState<T> {
  const [state, setState] = useState<AnalyticsState<T>>({ data: null, loading: false, error: null });
  const sig = call ? JSON.stringify(call) : null;

  useEffect(() => {
    if (!result || !sig) {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((s) => ({ data: s.data, loading: true, error: null }));
    analyticsClient()
      .call<T>(result.key, result.summary, JSON.parse(sig) as AnalyticsCall)
      .then(
        (data) => alive && setState({ data, loading: false, error: null }),
        (e: unknown) => alive && setState({ data: null, loading: false, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
  }, [result, sig]);

  return state;
}
