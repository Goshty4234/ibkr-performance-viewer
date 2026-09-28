'use client';

import { useMemo, useState } from 'react';
import type { EditablePortfolio } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import {
  ALIAS_CHEATSHEET,
  isInverse,
  parseTickerParameters,
  resolveTicker,
  SPECIAL_TICKERS,
  splitTickerList,
  withLeverage,
} from '@/lib/backtest/tickers';
import { useEngineStore } from '@/lib/engine/store';
import { NumField } from './fields';
import styles from './Backtester.module.css';

type Universe = { tickers: string[]; date_added: Record<string, string> | null };

/** Streamlit "Bulk Ticker Input", universes, bulk leverage, special tickers and alias cheat sheet. */
export default function TickerTools({ portfolio: p }: { portfolio: EditablePortfolio }) {
  const update = useBacktestStore((s) => s.updatePortfolio);
  const addStocks = useBacktestStore((s) => s.addStocks);
  const client = useEngineStore((s) => s.client);
  const [bulk, setBulk] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [universes, setUniverses] = useState<Partial<Record<'sp500' | 'us', Universe>>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [uniError, setUniError] = useState<string | null>(null);
  const [leverage, setLeverage] = useState(2);
  const [expense, setExpense] = useState(1);
  const [levPick, setLevPick] = useState<Set<string>>(new Set());

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((m) => (m === msg ? null : m)), 4000);
  };

  const parsed = () => splitTickerList(bulk).map(resolveTicker);

  function replaceAll() {
    const list = parsed();
    if (!list.length) return flash('Aucun ticker valide dans la boîte.');
    const stocks = list.map((ticker, i) => {
      const prev = p.stocks[i];
      return prev
        ? { ticker, allocation: prev.allocation, include_dividends: prev.include_dividends, include_in_sma_filter: true }
        : { ticker, allocation: 0, include_dividends: !isInverse(ticker), include_in_sma_filter: true };
    });
    update(p._id, { stocks });
    flash(`${list.length} tickers remplacés (allocations existantes conservées par position).`);
  }

  function addToExisting() {
    const list = parsed();
    if (!list.length) return flash('Aucun ticker valide dans la boîte.');
    addStocks(p._id, list);
    flash(`Tickers ajoutés à 0 % : ${list.slice(0, 12).join(', ')}${list.length > 12 ? '…' : ''}`);
  }

  function fetchCurrent() {
    const cur = p.stocks.map((s) => s.ticker).filter(Boolean);
    if (!cur.length) return flash('Aucun ticker dans ce portfolio.');
    setBulk(cur.join(' '));
  }

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      flash(`${what} copié${what.endsWith('s') ? 's' : ''} dans le presse-papiers.`);
    } catch {
      flash('Copie impossible (permission du navigateur).');
    }
  }

  async function loadUniverse(name: 'sp500' | 'us'): Promise<Universe | null> {
    if (universes[name]) return universes[name]!;
    if (!client) {
      setUniError('Moteur hors ligne : impossible de charger la liste.');
      return null;
    }
    setLoading(name);
    setUniError(null);
    try {
      const u = await client.universe(name);
      const val = { tickers: u.tickers, date_added: u.date_added };
      setUniverses((prev) => ({ ...prev, [name]: val }));
      return val;
    } catch (e) {
      setUniError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(null);
    }
  }

  const baseTickers = useMemo(
    () => [...new Set(p.stocks.map((s) => parseTickerParameters(s.ticker).base).filter(Boolean))],
    [p.stocks],
  );

  function applyLeverage(remove: boolean) {
    if (!levPick.size) return flash('Sélectionne au moins un ticker.');
    let n = 0;
    const stocks = p.stocks.map((s) => {
      const base = parseTickerParameters(s.ticker).base;
      if (!levPick.has(base) && !levPick.has(s.ticker)) return s;
      n++;
      if (remove) return { ...s, ticker: base };
      return { ...s, ticker: withLeverage(s.ticker, leverage, expense), ...(leverage < 0 ? { include_dividends: false } : {}) };
    });
    update(p._id, { stocks });
    flash(remove ? `Levier retiré de ${n} ticker(s).` : `Levier ${leverage}x et frais ${expense} % appliqués à ${n} ticker(s).`);
  }

  const leverageGroups = useMemo(() => {
    const groups = new Map<number, { ticker: string; expense: number }[]>();
    for (const s of p.stocks) {
      if (!s.ticker) continue;
      const { leverage: L, expense: E } = parseTickerParameters(s.ticker);
      if (L === 1 && E === 0) continue;
      const arr = groups.get(L) ?? [];
      arr.push({ ticker: s.ticker, expense: E });
      groups.set(L, arr);
    }
    return [...groups.entries()].sort((a, b) => b[0] - a[0]);
  }, [p.stocks]);

  const sp = universes.sp500;
  const us = universes.us;
  const current = new Set(p.stocks.map((s) => s.ticker));

  return (
    <details className={styles.details}>
      <summary>Outils tickers : saisie en masse, univers, levier, tickers spéciaux</summary>
      <div className={styles.detailsBody}>
        {notice && <div className={styles.notice}>{notice}</div>}

        <div className={styles.groupLabel}>Saisie en masse</div>
        <textarea
          className={styles.bulkArea}
          value={bulk}
          spellCheck={false}
          placeholder="SPY QQQ GLD TLT  (séparés par espaces ou virgules)"
          onChange={(e) => setBulk(e.target.value)}
        />
        <div className={styles.btnRow}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={replaceAll} disabled={!bulk.trim()} title="Remplace tous les tickers ; les allocations existantes sont conservées par position">
            Remplacer tout
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={addToExisting} disabled={!bulk.trim()} title="Ajoute les nouveaux tickers à 0 %">
            Ajouter aux existants
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={fetchCurrent}>Récupérer les tickers actuels</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(bulk.trim(), 'Tickers')} disabled={!bulk.trim()}>Copier</button>
          {bulk.trim() && <span className={styles.hint}>{splitTickerList(bulk).length} tickers</span>}
        </div>

        <div className={styles.groupLabel}>Univers</div>
        <div className={styles.btnRow}>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading === 'sp500'} onClick={async () => {
            const u = await loadUniverse('sp500');
            if (u) { setBulk(u.tickers.join(' ')); flash(`${u.tickers.length} tickers S&P 500 chargés dans la boîte.`); }
          }}>
            {loading === 'sp500' ? 'Chargement…' : 'Charger le S&P 500'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading === 'sp500'} onClick={async () => {
            const u = await loadUniverse('sp500');
            if (u) await copy(u.tickers.join(' '), `${u.tickers.length} tickers S&P 500`);
          }}>
            Copier le S&P 500
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading === 'us'} onClick={async () => {
            const u = await loadUniverse('us');
            if (u) { setBulk(u.tickers.join(' ')); flash(`${u.tickers.length} actions US chargées dans la boîte.`); }
          }}>
            {loading === 'us' ? 'Chargement…' : 'Charger toutes les actions US'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={loading === 'us'} onClick={async () => {
            const u = await loadUniverse('us');
            if (u) await copy(u.tickers.join(' '), `${u.tickers.length} actions US`);
          }}>
            Copier les actions US
          </button>
        </div>
        <div className={styles.hint}>
          S&P 500 : liste Wikipedia actuelle avec dates d’entrée. Actions US : annuaire Nasdaq Trader (NYSE/NASDAQ/AMEX, sans ETF ni warrants, microcaps incluses) ; un backtest de cet univers télécharge des milliers de séries.
        </div>
        {uniError && <div className={styles.errorBox}>{uniError}</div>}
        {us && <div className={styles.hint}>{us.tickers.length} actions US ordinaires.</div>}
        {sp && (
          <details className={styles.details}>
            <summary>
              Dates d’entrée S&P 500 ({sp.tickers.filter((t) => sp.date_added?.[t] || sp.date_added?.[t.replace(/-/g, '.')]).length}/{sp.tickers.length} datées)
            </summary>
            <div className={`${styles.detailsBody} ${styles.miniScroll}`}>
              <table className={styles.miniTable}>
                <thead><tr><th>Ticker</th><th>Date d’entrée</th></tr></thead>
                <tbody>
                  {sp.tickers.map((t) => (
                    <tr key={t}>
                      <td>{t}</td>
                      <td>{sp.date_added?.[t] || sp.date_added?.[t.replace(/-/g, '.')] || 'sans date'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        <div className={styles.groupLabel}>Levier et frais en masse</div>
        {baseTickers.length ? (
          <>
            <div className={styles.btnRow}>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLevPick(new Set(baseTickers))}>Tout</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setLevPick(new Set())}>Aucun</button>
            </div>
            <div className={styles.chipGrid}>
              {baseTickers.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`${styles.chip} ${levPick.has(t) ? styles.chipOn : ''}`}
                  onClick={() => setLevPick((prev) => {
                    const next = new Set(prev);
                    if (next.has(t)) next.delete(t);
                    else next.add(t);
                    return next;
                  })}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className={styles.grid2}>
              <NumField label="Levier" value={leverage} step={0.1} onChange={setLeverage} title="Négatif = position inverse (dividendes désactivés)" />
              <NumField label="Frais annuels (%)" value={expense} step={0.01} min={0} onChange={setExpense} />
            </div>
            <div className={styles.btnRow}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => applyLeverage(false)}>Appliquer à la sélection</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => applyLeverage(true)}>Retirer levier et frais</button>
            </div>
          </>
        ) : (
          <div className={styles.hint}>Ajoute des tickers pour appliquer un levier.</div>
        )}
        {leverageGroups.length > 0 && (
          <div className={styles.hint}>
            <b>Résumé du levier.</b> Coût quotidien du levier = (L − 1) × taux sans risque quotidien, plus les frais annuels répartis par jour.
            {leverageGroups.map(([L, items]) => (
              <div key={L}>
                <b>{L}x</b> : {items.map((i) => `${i.ticker}${i.expense ? ` (${i.expense} %/an)` : ''}`).join(', ')}
              </div>
            ))}
          </div>
        )}

        <div className={styles.groupLabel}>Tickers spéciaux (clic = ajouter)</div>
        {SPECIAL_TICKERS.map((g) => (
          <div key={g.group} style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <span className={styles.hint}>{g.group}</span>
            <div className={styles.chipGrid}>
              {g.items.map((it) => {
                const resolved = resolveTicker(it.alias);
                return (
                  <button
                    key={it.alias}
                    type="button"
                    className={`${styles.chip} ${current.has(resolved) ? styles.chipOn : ''}`}
                    title={`${it.alias} → ${resolved}${it.help ? `\n${it.help}` : ''}`}
                    onClick={() => addStocks(p._id, [it.alias])}
                  >
                    {it.label}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        <details className={styles.details}>
          <summary>Aide-mémoire des alias</summary>
          <div className={styles.detailsBody}>
            <table className={styles.miniTable}>
              <tbody>
                {ALIAS_CHEATSHEET.map(([a, d]) => (
                  <tr key={a}><td>{a}</td><td style={{ fontFamily: 'inherit' }}>{d}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </details>
  );
}
