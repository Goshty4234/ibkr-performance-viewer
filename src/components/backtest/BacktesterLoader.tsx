'use client';

import { useEffect, useState } from 'react';
import BacktesterApp from './BacktesterApp';

// Client-only (the workspace is restored from localStorage). A static import instead of next/dynamic:
// in dev, CSS that only lives in a dynamic chunk disappears after hot reloads.
export default function BacktesterLoader() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  if (!ready) {
    return <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)' }}>Chargement du backtester…</div>;
  }
  return <BacktesterApp />;
}
