'use client';

import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { portfolioColor } from '@/lib/backtest/chart-data';
import { defaultPortfolio, FREQUENCY_LABELS, isFusion, totalAllocation } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import styles from './Backtester.module.css';

const ROW_H = 50;

export default function PortfolioList() {
  const portfolios = useBacktestStore((s) => s.portfolios);
  const selectedId = useBacktestStore((s) => s.selectedId);
  const select = useBacktestStore((s) => s.select);
  const addPortfolio = useBacktestStore((s) => s.addPortfolio);
  const startRun = useBacktestStore((s) => s.startRun);
  const removePortfolios = useBacktestStore((s) => s.removePortfolios);
  const replaceAll = useBacktestStore((s) => s.replaceAll);
  const syncFromFirst = useBacktestStore((s) => s.syncFromFirst);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return portfolios
      .map((p, index) => ({ p, index }))
      .filter(({ p }) => !q || p.name.toLowerCase().includes(q) || p.stocks.some((s) => s.ticker.toLowerCase().includes(q)));
  }, [portfolios, query]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const activeId = selectedId ?? portfolios[0]?._id ?? null;
  const pickedIds = portfolios.filter((p) => picked.has(p._id)).map((p) => p._id);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((m) => (m === msg ? null : m)), 3500);
  };

  const sync = (what: 'cashflow' | 'rebalancing') => {
    const n = syncFromFirst(what);
    flash(n ? `${n} portfolio${n > 1 ? 's' : ''} synchronisé${n > 1 ? 's' : ''}` : 'Rien à synchroniser (exclus ou déjà identiques)');
  };

  return (
    <aside className={`card ${styles.listCard}`}>
      <div className={styles.listHead}>
        <span className={styles.listTitle}>
          Portfolios<span className={styles.listCount}>{portfolios.length}</span>
        </span>
        <span style={{ display: 'flex', gap: '0.3rem' }}>
          <button
            type="button"
            className={`btn btn-sm ${picking ? 'btn-secondary' : 'btn-ghost'}`}
            onClick={() => { setPicking(!picking); setPicked(new Set()); }}
            title="Sélection multiple (supprimer, lancer)"
          >
            ☑
          </button>
          <button type="button" className="btn btn-primary btn-sm" onClick={addPortfolio}>
            + Nouveau
          </button>
        </span>
      </div>
      {portfolios.length > 6 && (
        <input
          type="text"
          className={styles.search}
          placeholder="Filtrer (nom ou ticker)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}
      {picking && (
        <div className={styles.pickBar}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set(rows.map((r) => r.p._id)))}>
            Tout
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set())}>Aucun</button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            disabled={!pickedIds.length}
            onClick={() => {
              if (!confirm(`Supprimer ${pickedIds.length} portfolio(s) ?`)) return;
              removePortfolios(pickedIds);
              setPicked(new Set());
            }}
          >
            Supprimer ({pickedIds.length})
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!pickedIds.length} onClick={() => void startRun(pickedIds)}>
            ▶ Lancer ({pickedIds.length})
          </button>
        </div>
      )}
      <div className={styles.listScroll} ref={scrollRef}>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((v) => {
            const { p, index } = rows[v.index];
            const total = totalAllocation(p);
            const fusion = isFusion(p);
            const badAlloc = !fusion && Math.abs(total - 1) > 0.001;
            return (
              <div
                key={p._id}
                className={`${styles.pItem} ${p._id === activeId ? styles.pItemActive : ''}`}
                style={{ top: v.start, height: ROW_H - 4 }}
                onClick={() => (picking ? toggle(p._id) : select(p._id))}
                onDoubleClick={() => !picking && void startRun([p._id])}
                title={picking ? undefined : 'Double-clic : lancer seulement ce portfolio'}
              >
                {picking ? (
                  <input type="checkbox" checked={picked.has(p._id)} readOnly style={{ flexShrink: 0 }} aria-label={`Sélectionner ${p.name}`} />
                ) : (
                  <span className={styles.pSwatch} style={{ background: portfolioColor(index) }} />
                )}
                <span className={styles.pMain}>
                  <span className={styles.pName}>{p.name || 'Sans nom'}</span>
                  <span className={styles.pMeta}>
                    {fusion
                      ? `Fusion de ${p.fusion_portfolio?.selected_portfolios.length ?? 0} portfolios`
                      : `${p.stocks.length} ticker${p.stocks.length > 1 ? 's' : ''} · ${FREQUENCY_LABELS[p.rebalancing_frequency] ?? p.rebalancing_frequency}${p.use_momentum ? ' · momentum' : ''}${p.use_sma_filter ? ' · MA' : ''}`}
                  </span>
                </span>
                {fusion && <span className={styles.pTag}>FUSION</span>}
                {badAlloc && !p.use_momentum && <span className={styles.pWarn} title={`Allocation totale ${(total * 100).toFixed(1)} %`}>⚠</span>}
              </div>
            );
          })}
        </div>
      </div>
      {portfolios.length > 1 && (
        <div className={styles.syncBar}>
          <span className={styles.syncLabel}>Copier depuis le 1er portfolio</span>
          <div className={styles.syncButtons}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => sync('cashflow')} title="Copie la valeur initiale, l’apport et la fréquence d’apport du 1er portfolio dans tous les autres, sauf ceux cochés « Ne pas écraser par ⇄ Apports »">
              ⇄ Apports
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => sync('rebalancing')} title="Copie la fréquence de rebalancement du 1er portfolio dans tous les autres, sauf ceux cochés « Ne pas écraser par ⇄ Rebalancement »">
              ⇄ Rebalancement
            </button>
          </div>
        </div>
      )}
      {notice && <div className={styles.notice}>{notice}</div>}
      <div className={styles.listFoot}>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={!activeId}
          onClick={() => activeId && void startRun([activeId])}
        >
          ▶ Seulement celui-ci
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!portfolios.length} onClick={() => void startRun()}>
          ▶ Tous
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={!portfolios.length}
          title="Supprimer tous les portfolios"
          onClick={() => { if (confirm('Effacer tous les portfolios ?')) replaceAll([defaultPortfolio('Nouveau portfolio')]); }}
        >
          Tout effacer
        </button>
      </div>
    </aside>
  );
}
