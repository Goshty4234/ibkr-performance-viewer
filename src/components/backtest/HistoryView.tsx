'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { deleteRun, getRunRow, listRuns, loadRun, renameRun, setPinned, type BacktestRunRow } from '@/lib/backtest/history';
import { normalizeImported } from '@/lib/backtest/portfolio';
import { useBacktestStore } from '@/lib/backtest/store';
import HistorySetup from './HistorySetup';
import styles from './Results.module.css';
import bt from './Backtester.module.css';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('fr-CA', { dateStyle: 'medium', timeStyle: 'short' });
}

function fmtSize(b: number | null): string {
  if (!b) return '';
  return b > 1e6 ? `${(b / 1e6).toFixed(1)} Mo` : `${Math.round(b / 1e3)} ko`;
}

function toneClass(v: string | undefined): string {
  const n = v ? parseFloat(v) : NaN;
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? styles.pos : styles.neg;
}

export default function HistoryView() {
  const showResult = useBacktestStore((s) => s.showResult);
  const replaceAll = useBacktestStore((s) => s.replaceAll);
  const setView = useBacktestStore((s) => s.setView);
  const currentRunId = useBacktestStore((s) => s.resultRunId);

  const [rows, setRows] = useState<BacktestRunRow[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [setups, setSetups] = useState<Record<string, NonNullable<BacktestRunRow['request']> | null>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const toggleSetup = (row: BacktestRunRow) => {
    const open = !expanded.has(row.id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(row.id); else next.delete(row.id);
      return next;
    });
    if (open && !(row.id in setups)) {
      void act(row.id, async () => {
        const full = await getRunRow(row.id).catch((e: unknown) => {
          setSetups((s) => ({ ...s, [row.id]: null }));
          throw e;
        });
        setSetups((s) => ({ ...s, [row.id]: full.request?.portfolios?.length ? full.request : null }));
      });
    }
  };

  const refresh = useCallback(async () => {
    setError('');
    try {
      setRows(await listRuns(200));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, currentRunId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(q) || r.summary.some((s) => s.name.toLowerCase().includes(q)));
  }, [rows, filter]);

  async function act(id: string, fn: () => Promise<void>) {
    setBusy(id);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const open = (row: BacktestRunRow) =>
    act(row.id, async () => {
      const { result } = await loadRun(row.id);
      if (!result) throw new Error('Le fichier de résultat de ce run est introuvable.');
      showResult(result, row.id, row.label);
    });

  const restore = (row: BacktestRunRow) =>
    act(row.id, async () => {
      const full = await getRunRow(row.id);
      const req = full.request;
      if (!req?.portfolios?.length) throw new Error('Configuration non disponible pour ce run.');
      if (!confirm(`Remplacer les portfolios actuels par les ${req.portfolios.length} de ce run ?`)) return;
      replaceAll(req.portfolios.map((p) => normalizeImported(p as Record<string, unknown>)), req.options);
      setView('build');
    });

  const remove = (row: BacktestRunRow) =>
    act(row.id, async () => {
      if (!confirm(`Supprimer « ${row.label} » ?`)) return;
      await deleteRun(row);
      setRows((r) => r?.filter((x) => x.id !== row.id) ?? null);
    });

  const pin = (row: BacktestRunRow) =>
    act(row.id, async () => {
      await setPinned(row.id, !row.pinned);
      await refresh();
    });

  const saveLabel = () => {
    if (!editing) return;
    const { id, label } = editing;
    setEditing(null);
    const clean = label.trim();
    if (!clean) return;
    void act(id, async () => {
      await renameRun(id, clean);
      setRows((r) => r?.map((x) => (x.id === id ? { ...x, label: clean } : x)) ?? null);
    });
  };

  const pinnedCount = rows?.filter((r) => r.pinned).length ?? 0;

  return (
    <div className={styles.results}>
      <div className={`card ${styles.summary}`}>
        <div className={styles.summaryMain}>
          <div className={styles.summaryTitle}>
            Historique des runs
            {rows && rows.length > 0 && <span className={styles.historyCount}>{rows.length}</span>}
            {pinnedCount > 0 && <span className={styles.historyCount}>★ {pinnedCount}</span>}
          </div>
          <div className={styles.summaryMeta}>
            <span>Chaque run terminé est enregistré automatiquement dans ton compte Supabase (résultats compressés). Double-clic sur un nom pour le renommer.</span>
          </div>
        </div>
        <div className={`${styles.summaryControls} ${styles.historyControls}`}>
          <input className={styles.historySearch} placeholder="Filtrer par nom ou portfolio…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh()}>↻ Rafraîchir</button>
        </div>
      </div>

      {error && <div className={bt.errorBox}>{error}</div>}

      {rows === null ? (
        <div className={`card ${bt.empty}`}>Chargement…</div>
      ) : filtered.length === 0 ? (
        <div className={`card ${bt.empty}`}>
          <h2>{rows.length ? 'Aucun run ne correspond' : 'Aucun run pour l’instant'}</h2>
          {!rows.length && <p>Les backtests terminés apparaîtront ici.</p>}
        </div>
      ) : (
        <div className={styles.historyList}>
          {filtered.map((row) => {
            const ok = row.summary.filter((s) => s.ok);
            const isCurrent = row.id === currentRunId;
            const isOpen = expanded.has(row.id);
            const setup = setups[row.id];
            return (
              <div key={row.id} className={`card ${styles.historyItem} ${isCurrent ? styles.historyCurrent : ''} ${isOpen ? styles.historyExpanded : ''}`}>
                <div className={styles.historyHead}>
                  <div className={styles.historyTitleWrap}>
                    {row.pinned && <span title="Épinglé">📌</span>}
                    {editing?.id === row.id ? (
                      <input
                        className={bt.search}
                        autoFocus
                        value={editing.label}
                        onChange={(e) => setEditing({ id: row.id, label: e.target.value })}
                        onBlur={saveLabel}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveLabel();
                          if (e.key === 'Escape') setEditing(null);
                        }}
                      />
                    ) : (
                      <span
                        className={styles.historyTitle}
                        title="Double-clic pour renommer"
                        onDoubleClick={() => setEditing({ id: row.id, label: row.label })}
                      >
                        {row.label}
                      </span>
                    )}
                  </div>
                  <div className={styles.historyActions}>
                    <button type="button" className={bt.iconBtn} disabled={busy === row.id} onClick={() => void pin(row)} title={row.pinned ? 'Désépingler' : 'Épingler'}>
                      {row.pinned ? '★' : '☆'}
                    </button>
                    <button type="button" className={bt.iconBtn} onClick={() => setEditing({ id: row.id, label: row.label })} title="Renommer">✎</button>
                    <button type="button" className={`${bt.iconBtn} ${bt.iconBtnDanger}`} disabled={busy === row.id} onClick={() => void remove(row)} title="Supprimer">🗑</button>
                  </div>
                </div>
                <div className={styles.historyMeta}>
                  <span>{fmtDate(row.created_at)}</span>
                  {row.simulation_start && <span className={styles.historyTag}>{row.simulation_start} → {row.simulation_end}</span>}
                  <span className={styles.historyTag}>{row.summary.length} portfolio{row.summary.length > 1 ? 's' : ''}</span>
                  {row.duration_s !== null && <span className={styles.historyTag}>{row.duration_s.toFixed(1)} s</span>}
                  <span className={styles.historyTag}>{row.engine === 'local' ? 'Mon PC' : row.engine}</span>
                  {row.result_size ? <span className={styles.historyTag}>{fmtSize(row.result_size)}</span> : null}
                  {row.summary.length !== ok.length && <span className={`${styles.historyTag} ${styles.saveErr}`}>{row.summary.length - ok.length} en échec</span>}
                </div>
                {ok.length > 0 && (
                  <div className={styles.historyStats}>
                    <div className={`${styles.historyStatRow} ${styles.historyStatHead}`}>
                      <span>Portfolio</span><span>CAGR</span><span>Max DD</span><span>Sharpe</span>
                    </div>
                    {ok.slice(0, 5).map((s) => (
                      <div key={s.name} className={styles.historyStatRow}>
                        <span className={styles.historyStatName} title={s.name}>{s.name}</span>
                        <span className={toneClass(s.cagr)}>{s.cagr ?? '—'}</span>
                        <span className={styles.neg}>{s.maxdd ?? '—'}</span>
                        <span>{s.sharpe ?? '—'}</span>
                      </div>
                    ))}
                    {ok.length > 5 && <div className={styles.historyMore}>+{ok.length - 5} autres portfolios</div>}
                  </div>
                )}
                <div className={styles.historyFooter}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy === row.id || !row.result_path || isCurrent} onClick={() => void open(row)}>
                    {busy === row.id ? '…' : isCurrent ? '✓ Affiché' : 'Ouvrir les résultats'}
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy === row.id} onClick={() => void restore(row)} title="Recharger ces portfolios dans le constructeur">
                    Restaurer la config
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleSetup(row)} aria-expanded={isOpen}>
                    {isOpen ? '▾ Masquer le setup' : '▸ Voir le setup'}
                  </button>
                </div>
                {isOpen && (
                  setup === undefined ? (
                    <div className={styles.historyMore}>Chargement du setup…</div>
                  ) : setup === null ? (
                    <div className={styles.historyMore}>Configuration non enregistrée pour ce run.</div>
                  ) : (
                    <HistorySetup portfolios={setup.portfolios} options={setup.options ?? {}} simulationEnd={row.simulation_end} />
                  )
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
