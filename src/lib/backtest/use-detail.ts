'use client';

import { useEffect, useState } from 'react';
import type { PortfolioDetail } from '@/lib/engine/types';
import { detailCache, type LoadedResult } from './result-data';

export interface DetailState {
  detail: PortfolioDetail | null;
  loading: boolean;
  error: string | null;
}

/** Detail chunk of one portfolio, fetched on first use and kept in the shared LRU. */
export function usePortfolioDetail(result: LoadedResult | null, index: number | null): DetailState {
  const [state, setState] = useState<DetailState>({ detail: null, loading: false, error: null });

  useEffect(() => {
    if (!result || index === null) {
      setState({ detail: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((s) => ({ detail: s.detail?.index === index ? s.detail : null, loading: true, error: null }));
    detailCache.get(result, index).then(
      (detail) => {
        if (alive) {
          setState({
            detail,
            loading: false,
            error: detail
              ? null
              : result.detailsPartial
                ? 'Détail non conservé pour ce run (seuls les résumés légers sont gardés). Relance le backtest pour le revoir : « Restaurer la config » dans Historique, puis Lancer.'
                : 'Détail indisponible pour ce portfolio.',
          });
        }
      },
      (e: unknown) => {
        if (alive) setState({ detail: null, loading: false, error: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [result, index]);

  return state;
}
