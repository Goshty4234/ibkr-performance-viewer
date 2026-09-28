'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type EditablePortfolio, totalAllocation } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import { isInverse, nonUsdTickers, resolveTicker, searchSpecialTickers } from '@/lib/backtest/tickers';
import { useEngineStore } from '@/lib/engine/store';
import { NumInput } from './fields';
import TickerTools from './TickerTools';
import styles from './Backtester.module.css';

const ROW_H = 42;

interface Quote { symbol: string; name: string; exchange: string; type: string; special?: boolean }

export default function StocksTable({ portfolio: p }: { portfolio: EditablePortfolio }) {
  const updateStock = useBacktestStore((s) => s.updateStock);
  const addStocks = useBacktestStore((s) => s.addStocks);
  const removeStock = useBacktestStore((s) => s.removeStock);
  const equalize = useBacktestStore((s) => s.equalizeStocks);
  const update = useBacktestStore((s) => s.updatePortfolio);
  const client = useEngineStore((s) => s.client);
  const scrollRef = useRef<HTMLDivElement>(null);
  const focusTicker = useRef('');
  const [draft, setDraft] = useState('');
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [activeQuote, setActiveQuote] = useState(-1);
  const [suggestHidden, setSuggestHidden] = useState(false);

  const showCap = p.use_momentum;
  const showMa = p.use_sma_filter;
  const showMaRef = Boolean(p.use_sma_filter) && !(p.use_global_ma_reference && String(p.global_ma_reference_ticker ?? '').trim());
  const columns = [
    'minmax(90px, 1.3fr)',
    'minmax(90px, 1fr)',
    ...(showCap ? ['minmax(70px, 0.8fr)'] : []),
    ...(showMaRef ? ['minmax(80px, 1fr)'] : []),
    '70px',
    ...(showMa ? ['70px'] : []),
    '34px',
  ].join(' ');

  const virtualizer = useVirtualizer({
    count: p.stocks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  useEffect(() => {
    const q = draft.trim();
    if (!client || q.length < 2 || /[\s,;_]/.test(q)) {
      setQuotes([]);
      return;
    }
    const t = setTimeout(() => {
      client.searchTickers(q).then(setQuotes).catch(() => setQuotes([]));
    }, 250);
    return () => clearTimeout(t);
  }, [draft, client]);

  const suggestions = useMemo<Quote[]>(() => {
    const q = draft.trim();
    if (!q || /[,;]/.test(q)) return [];
    const local: Quote[] = searchSpecialTickers(q).map((s) => ({
      symbol: s.alias,
      name: s.label,
      exchange: s.target !== s.alias ? `→ ${s.target}` : 'Série du moteur',
      type: '',
      special: true,
    }));
    const taken = new Set(local.map((s) => resolveTicker(s.symbol)));
    const remote = quotes.filter((x) => !taken.has(resolveTicker(x.symbol)));
    const exact = remote.filter((x) => x.symbol.toUpperCase() === q.toUpperCase());
    return [...exact, ...local, ...remote.filter((x) => !exact.includes(x))];
  }, [draft, quotes]);

  function commit(value: string) {
    const tickers = value.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean);
    if (!tickers.length) return;
    addStocks(p._id, tickers);
    setDraft('');
    setQuotes([]);
    setActiveQuote(-1);
    requestAnimationFrame(() => virtualizer.scrollToIndex(p.stocks.length + tickers.length - 1));
  }

  function normalize() {
    const sum = p.stocks.reduce((a, s) => a + (s.ticker.trim() ? s.allocation || 0 : 0), 0);
    if (sum <= 0) return;
    update(p._id, { stocks: p.stocks.map((s) => ({ ...s, allocation: s.ticker.trim() ? (s.allocation || 0) / sum : 0 })) });
  }

  const total = totalAllocation(p);
  const allocOk = Math.abs(total - 1) < 0.001;
  const foreign = nonUsdTickers(p.stocks.map((s) => s.ticker));

  return (
    <section className={`card ${styles.section}`}>
      <div className={styles.sectionHead}>
        <span className={styles.sectionTitle}>
          Actifs <span className={styles.listCount}>{p.stocks.length}</span>
        </span>
        <div className={styles.allocBar}>
          <span>
            Total{' '}
            <b className={allocOk ? styles.allocOk : styles.allocBad}>{(total * 100).toFixed(2)} %</b>
            {p.use_momentum && <span> (ignoré : momentum actif)</span>}
          </span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!p.stocks.length || total <= 0} onClick={normalize} title="Ramène le total à 100 % en gardant les proportions">
            Normaliser
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!p.stocks.length} onClick={() => equalize(p._id)}>
            Poids égaux
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={!p.stocks.length}
            onClick={() => { if (confirm('Retirer tous les tickers ?')) update(p._id, { stocks: [] }); }}
          >
            Tout retirer
          </button>
        </div>
      </div>

      <div className={styles.addRow}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            value={draft}
            placeholder="Ajouter : SPY  ou colle une liste « QQQ, GLD, TLT, SPY?L=3 »"
            spellCheck={false}
            onChange={(e) => { setDraft(e.target.value); setActiveQuote(-1); setSuggestHidden(false); }}
            onBlur={() => setSuggestHidden(true)}
            onFocus={() => setSuggestHidden(false)}
            onKeyDown={(e) => {
              if (suggestHidden && e.key !== 'Enter') setSuggestHidden(false);
              if (e.key === 'ArrowDown' && suggestions.length) { e.preventDefault(); setActiveQuote((i) => Math.min(suggestions.length - 1, i + 1)); }
              else if (e.key === 'ArrowUp' && suggestions.length) { e.preventDefault(); setActiveQuote((i) => Math.max(-1, i - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); commit(activeQuote >= 0 && suggestions[activeQuote] ? suggestions[activeQuote].symbol : draft); }
              else if (e.key === 'Escape') { setSuggestHidden(true); setActiveQuote(-1); }
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData('text');
              if (/[\s,;]/.test(text.trim())) { e.preventDefault(); commit(text); }
            }}
          />
          {!suggestHidden && suggestions.length > 0 && (
            <div className={styles.suggest}>
              {suggestions.map((q, i) => (
                <button
                  key={`${q.special ? 's' : 'y'}:${q.symbol}`}
                  type="button"
                  className={`${styles.suggestItem} ${i === activeQuote ? styles.suggestItemActive : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); commit(q.symbol); }}
                >
                  <span className={`${styles.suggestSym} ${q.special ? styles.suggestSpecial : ''}`}>{q.symbol}</span>
                  <span className={styles.suggestName}>{q.name}</span>
                  <span className={styles.suggestEx}>{q.type ? `${q.exchange} · ${q.type}` : q.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => commit(draft)} disabled={!draft.trim()}>
          Ajouter
        </button>
      </div>

      {foreign.length > 0 && (
        <div className={styles.warnBox}>
          Devise : {foreign.slice(0, 8).join(', ')}{foreign.length > 8 ? '…' : ''} ne sont probablement pas en USD. Les prix sont utilisés tels quels (pas de conversion de change), comme dans le backtester Streamlit.
        </div>
      )}

      {p.stocks.length > 0 && (
        <div>
          <div className={styles.stocksHead} style={{ gridTemplateColumns: columns }}>
            <span>Ticker</span>
            <span>Allocation</span>
            {showCap && <span title="Plafond individuel appliqué par le momentum (0 = aucun)">Max Cap %</span>}
            {showMaRef && <span title="Ticker dont la moyenne mobile décide pour cet actif (vide = lui-même)">Réf. MA</span>}
            <span style={{ textAlign: 'center' }}>Dividendes</span>
            {showMa && <span style={{ textAlign: 'center' }} title="Inclus dans le filtre moyenne mobile">Filtre MA</span>}
            <span />
          </div>
          <div className={styles.stocksScroll} ref={scrollRef}>
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((v) => {
                const s = p.stocks[v.index];
                return (
                  <div key={v.key} className={styles.stockRow} style={{ top: v.start + 4, height: ROW_H - 6, gridTemplateColumns: columns }}>
                    <input
                      type="text"
                      value={s.ticker}
                      spellCheck={false}
                      onFocus={(e) => { focusTicker.current = e.target.value; }}
                      onChange={(e) => updateStock(p._id, v.index, { ticker: e.target.value.toUpperCase() })}
                      onBlur={(e) => {
                        const resolved = resolveTicker(e.target.value);
                        const changed = resolved !== focusTicker.current;
                        if (!changed && resolved === s.ticker) return;
                        updateStock(p._id, v.index, {
                          ticker: resolved,
                          ...(changed && isInverse(resolved) ? { include_dividends: false } : {}),
                        });
                      }}
                    />
                    <NumInput
                      value={s.allocation}
                      scale={100}
                      suffix="%"
                      min={0}
                      max={100}
                      step={1}
                      onChange={(x) => updateStock(p._id, v.index, { allocation: x })}
                    />
                    {showCap && (
                      <NumInput
                        value={s.max_allocation_percent ?? 0}
                        suffix="%"
                        min={0}
                        max={100}
                        step={1}
                        title="0 = pas de plafond"
                        onChange={(x) => updateStock(p._id, v.index, { max_allocation_percent: x > 0 ? x : null })}
                      />
                    )}
                    {showMaRef && (
                      <input
                        type="text"
                        value={s.ma_reference_ticker ?? ''}
                        placeholder={s.ticker.split('?')[0] || 'lui-même'}
                        spellCheck={false}
                        onChange={(e) => updateStock(p._id, v.index, { ma_reference_ticker: e.target.value.toUpperCase() })}
                        onBlur={(e) => {
                          const v2 = e.target.value.trim();
                          updateStock(p._id, v.index, { ma_reference_ticker: v2 ? resolveTicker(v2) : '' });
                        }}
                      />
                    )}
                    <input
                      type="checkbox"
                      checked={s.include_dividends}
                      onChange={(e) => updateStock(p._id, v.index, { include_dividends: e.target.checked })}
                      aria-label="Inclure les dividendes"
                    />
                    {showMa && (
                      <input
                        type="checkbox"
                        checked={s.include_in_sma_filter !== false}
                        onChange={(e) => updateStock(p._id, v.index, { include_in_sma_filter: e.target.checked })}
                        aria-label="Inclus dans le filtre MA"
                      />
                    )}
                    <button
                      type="button"
                      className={`${styles.iconBtn} ${styles.iconBtnDanger}`}
                      onClick={() => removeStock(p._id, v.index)}
                      title="Retirer"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <TickerTools portfolio={p} />
    </section>
  );
}
